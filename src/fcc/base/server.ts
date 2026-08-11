/**
 * server.ts — the FCC extension's HTTP surface: `POST /action` and `GET /state`.
 *
 * Ported from Flare's `fce-extension-scaffold`. The whole surface is those two routes; everything
 * else about how an instruction reaches here — the on-chain `sendInstructions`, the data providers
 * reaching 50%+ signing weight, the proxy queue, the node pulling work — is Flare's, and this
 * process only ever sees the last hop.
 *
 * THREE THINGS THAT ARE NOT STYLE.
 *
 * HANDLERS ARE SERIALIZED. Every call goes through one promise queue, and the queue advances even
 * when a handler rejects. Two settlements decrypting concurrently would race on the node's sign
 * port, and a rejection that stalled the queue would wedge the extension until it was restarted —
 * which under FCC means an instruction that is accepted on chain and never answered.
 *
 * A MISSING HANDLER IS 501, WITH THE NAMES DECODED. `unsupported op type` is the single most
 * common FCC failure and the cause is always the same: the `bytes32("...")` constant in Solidity
 * and the string constant here do not match. Answering with the decoded names turns an afternoon
 * of guessing into one glance.
 *
 * THE RESULT JSON IS THE SIGNED ARTIFACT. Every `ActionResult` field is emitted, in Go struct
 * order, with `data` and `additionalResultStatus` as `"0x"` rather than omitted when empty. This
 * is not tidiness — the node hashes these bytes.
 */

import { createServer, type Server } from 'node:http';
import { hexToBytes, bytes32HexToString } from './encoding.js';
import {
    logFor,
    stateVersionOf,
    Framework,
    STATUS_ERROR,
    type Action,
    type ActionResult,
    type DataFixed,
    type ReportStateFunc,
    type RegisterFunc,
    type StateResponse,
} from './types.js';
import { errorMessage, log } from '../../log.js';

/** An instruction payload is a bytes32 id. The cap is generous and still bounded. */
const MAX_ACTION_BYTES = 1_000_000;

export class ExtensionServer {
    private readonly framework = new Framework();
    private server: Server | undefined;
    /** The serialization point. See the header. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly extensionPort: string | number,
        private readonly version: string,
        register: RegisterFunc,
        private readonly reportState: ReportStateFunc,
    ) {
        register(this.framework);
    }

    private serialize<T>(task: () => Promise<T>): Promise<T> {
        const run = this.queue.then(task, task);
        // Swallow here only: the caller still sees the rejection through `run`. Without this the
        // chained queue would carry an unhandled rejection forward.
        this.queue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /** Exposed so a local test can drive the routing with no socket. */
    async handleRequest(method: string, path: string, body: string): Promise<[number, unknown]> {
        const route = path.split('?')[0] ?? '/';

        if (route === '/state') {
            if (method !== 'GET') return [405, { error: 'method not allowed' }];
            const state = await this.serialize(async () => this.reportState());
            const response: StateResponse = {
                stateVersion: stateVersionOf(this.version),
                state,
            };
            return [200, response];
        }

        if (route === '/action') {
            if (method !== 'POST') return [405, { error: 'method not allowed' }];
            return this.handleAction(body);
        }

        return [404, { error: 'not found' }];
    }

    private async handleAction(body: string): Promise<[number, unknown]> {
        if (body.length > MAX_ACTION_BYTES) return [400, { error: 'action body too large' }];

        let action: Action;
        try {
            action = JSON.parse(body) as Action;
        } catch {
            return [400, { error: 'action is not valid JSON' }];
        }
        if (!action?.data) return [400, { error: 'action has no data' }];

        let fixed: DataFixed;
        try {
            const decoded = Buffer.from(hexToBytes(action.data.message)).toString('utf8');
            fixed = JSON.parse(decoded) as DataFixed;
        } catch (err) {
            return [400, { error: `action message is not decodable: ${errorMessage(err)}` }];
        }
        if (!fixed?.opType) return [400, { error: 'action message has no opType' }];

        const opCommand = fixed.opCommand ?? '';
        const handler = this.framework.lookup(fixed.opType, opCommand);

        if (!handler) {
            // Decoded, because the raw bytes32 pair tells a reader nothing about which side is
            // wrong. This is the message that saves the afternoon.
            return [
                501,
                {
                    error:
                        `no handler for opType "${bytes32HexToString(fixed.opType)}" ` +
                        `opCommand "${bytes32HexToString(opCommand)}" — the bytes32 constants in ` +
                        `EvaluationInstructionSender.sol and src/fcc/app/config.ts must match exactly`,
                },
            ];
        }

        const [data, status, error] = await this.serialize(async () => {
            try {
                return await handler(fixed.originalMessage ?? '0x');
            } catch (err) {
                // A handler that throws is an enclave that could not answer, which is status 0.
                // It is NOT the same as a verdict of "invalid" — that is a successful answer.
                return [null, STATUS_ERROR, errorMessage(err)] as const;
            }
        });

        const result: ActionResult = {
            id: action.data.id,
            submissionTag: action.data.submissionTag,
            status,
            log: logFor(status, error),
            opType: fixed.opType,
            opCommand,
            additionalResultStatus: '0x',
            version: this.version,
            data: data ?? '0x',
        };

        return [200, result];
    }

    listenAndServe(): Promise<void> {
        return new Promise((resolve) => {
            this.server = createServer((req, res) => {
                void (async () => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) chunks.push(chunk as Buffer);
                    const [status, payload] = await this.handleRequest(
                        req.method ?? 'GET',
                        req.url ?? '/',
                        Buffer.concat(chunks).toString('utf8'),
                    );
                    const text = JSON.stringify(payload);
                    res.writeHead(status, {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(text),
                    });
                    res.end(text);
                })();
            });
            this.server.listen(this.extensionPort, () => {
                log.info('fcc extension listening', { port: String(this.extensionPort) });
                resolve();
            });
        });
    }

    close(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) return resolve();
            this.server.close(() => resolve());
        });
    }
}
