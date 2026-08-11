/**
 * server.ts — the EIP-712 service: six routes, node's own http, no framework.
 *
 * No framework on purpose. This process becomes a container image whose hash is its on-chain
 * identity, so every dependency is a thing that must be pinned, audited and re-attested when it
 * moves. Six routes do not justify that.
 *
 * THE SHAPE IS A DEVIATION FROM THE REFERENCE, AND A DELIBERATE ONE. Flare's engine exposed only
 * `POST /validate`, because its keeper ran in the same process and submitted its own transactions
 * — which put the thing that decides WHEN to settle inside the enclave that decides WHAT the
 * settlement says. Here the keeper is a separate repo (`scheduler`) and this service hands it a
 * finished, signed settlement to submit. The signature covers the score, the ground-truth value,
 * the entry list and the receipt hash together, so a relayer can stall, reorder or refuse and
 * cannot alter a single number.
 *
 * `/validate` is deliberately UNSIGNED. It answers "was this well formed", and payment is released
 * on that alone; whether the forecast was ACCURATE is a later, separate question that only touches
 * reputation. The FCC path does sign its verdict, because `releasePaymentFromTee` needs one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Hex } from 'viem';
import { EngineError, statusFor } from './errors.js';
import { errorMessage, log } from './log.js';
import { fetchAttestationToken, nonceFor } from './attestation.js';
import { wireCompetitionSettlement, wireJobSettlement } from './settlement.js';
import { bindingOf, readRegisteredTee } from './chain/registry.js';
import type { Engine } from './engine.js';
import type { EngineConfig } from './config.js';
import type { TeeIdentity } from './keys.js';
import type { ChainReader } from './chain/reads.js';

/** Bodies are two hex ids at most. Anything larger is a mistake or an attempt. */
const MAX_REQUEST_BYTES = 4096;

/**
 * The POST routes that move money or write reputation, and so require `x-intake-token` when a token
 * is configured.
 *
 * The GET routes are deliberately excluded: `/health`, `/pubkey` and `/attestation` publish facts
 * that are already public on chain, and `/pubkey` in particular must stay open because every buyer
 * needs it to seal a delivery. Gating it would break job creation to protect nothing.
 */
const GUARDED_ROUTES = new Set(['/validate', '/score-job', '/score-market', '/settle-competition']);

/**
 * Compare in constant time, so a wrong token cannot be recovered byte by byte from response timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the length through the error path,
 * so the lengths are checked first and a mismatch is reported as a plain failure.
 */
function tokenMatches(expected: string, provided: string | undefined): boolean {
    if (provided === undefined) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export interface ServiceDeps {
    readonly engine: Engine;
    readonly chain: ChainReader;
    readonly config: EngineConfig;
    readonly identity: TeeIdentity;
    readonly version: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
    });
    res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > MAX_REQUEST_BYTES) throw new Error('request body too large');
        chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Pull one bytes32 id out of the body.
 *
 * Strict on purpose. A loose parse that accepted a short hex string would let a typo become a
 * silently different id, and `payForJob` reverts `JobExists` on any pre-existing id — so an id
 * that is wrong in a way nothing notices is an id burned forever.
 */
function readId(raw: string, field: string): Hex {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw || '{}');
    } catch {
        throw new EngineError('unsupported', 'the request body is not valid JSON');
    }
    const value = (parsed as Record<string, unknown> | null)?.[field];
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new EngineError('unsupported', `"${field}" must be a 32-byte hex id`);
    }
    return value as Hex;
}

export function makeService(deps: ServiceDeps): Server {
    const simulateAttestation = process.env['SIMULATE_ATTESTATION'] !== 'false';

    async function health(): Promise<unknown> {
        // Both probes are allowed to fail: a health check that throws when a dependency is down
        // tells an operator nothing except that something is down. Naming WHICH one is the job.
        const registered = await readRegisteredTee(deps.chain.client, deps.config.teeRegistry)
            .then((tee) => ({
                wallet: tee.wallet,
                imageDigest: tee.imageDigest,
                isThisInstance: tee.wallet.toLowerCase() === deps.identity.address.toLowerCase(),
                // The state a supervisor polls. `isThisInstance` compares the WALLET and is kept
                // for compatibility, but it reads as healthy while the published PUBLIC KEY is
                // stale — and the public key is what every agent seals to. See `bindingOf`.
                binding: bindingOf(tee, deps.identity),
                publicKeyMatches:
                    tee.publicKey.toLowerCase() === deps.identity.publicKey.toLowerCase(),
            }))
            .catch((err) => ({ error: errorMessage(err) }));

        const da = await fetch(`${deps.config.daBaseUrl}/api/v0/fsp/status`)
            .then((res) => (res.ok ? 'ok' : `status ${res.status}`))
            .catch(() => 'unreachable');

        return {
            ok: true,
            version: deps.version,
            chainId: deps.config.chainId,
            tee: { address: deps.identity.address, publicKey: deps.identity.publicKey },
            imageDigest: deps.config.teeImageDigest,
            addresses: {
                jobEscrow: deps.config.jobEscrow,
                sealedCompetition: deps.config.sealedCompetition,
                teeRegistry: deps.config.teeRegistry,
            },
            registered,
            daLayer: da,
        };
    }

    async function route(
        method: string,
        path: string,
        body: string,
        token: string | undefined,
    ): Promise<[number, unknown]> {
        // Before any work, and before the body is even looked at. `/validate` is what releases an
        // escrow, so an unauthenticated caller must not be able to spend enclave time either.
        const expected = deps.config.internalToken;
        if (expected !== undefined && method === 'POST' && GUARDED_ROUTES.has(path)) {
            if (!tokenMatches(expected, token)) {
                return [401, { error: 'x-intake-token missing or wrong', kind: 'unauthorized' }];
            }
        }

        if (method === 'GET' && path === '/health') return [200, await health()];

        if (method === 'GET' && path === '/pubkey') {
            // The single most consequential response this service gives. Every agent seals to
            // this key, and a wrong one means deliveries nobody can ever open.
            return [200, { address: deps.identity.address, publicKey: deps.identity.publicKey }];
        }

        if (method === 'GET' && path === '/attestation') {
            const token = await fetchAttestationToken({
                audience: deps.config.teeRegistry,
                nonce: nonceFor(deps.identity.address, deps.identity.publicKey),
                simulate: simulateAttestation,
            });
            return [200, { token, address: deps.identity.address, simulated: simulateAttestation }];
        }

        if (method === 'POST' && path === '/validate') {
            const verdict = await deps.engine.validateJob(readId(body, 'jobId'));
            return [200, verdict];
        }

        if (method === 'POST' && path === '/score-market') {
            // Scores, and says plainly that it cannot settle. See engine.scoreMarketJob.
            return [200, await deps.engine.scoreMarketJob(readId(body, 'jobId'))];
        }

        if (method === 'POST' && path === '/score-job') {
            const { settlement, signature } = await deps.engine.scoreJob(readId(body, 'jobId'));
            return [200, wireJobSettlement(settlement, signature)];
        }

        if (method === 'POST' && path === '/settle-competition') {
            const { settlement, signature } = await deps.engine.settleCompetition(
                readId(body, 'competitionId'),
            );
            return [200, wireCompetitionSettlement(settlement, signature)];
        }

        // A GET on a POST route is a different mistake from a typo'd path, and 405 says so.
        const posts = ['/validate', '/score-job', '/settle-competition', '/score-market'];
        const gets = ['/health', '/pubkey', '/attestation'];
        if (posts.includes(path) || gets.includes(path))
            return [405, { error: 'method not allowed' }];
        return [404, { error: 'not found' }];
    }

    return createServer((req, res) => {
        // No CORS headers. The Sui engine set `allow_methods(Any)` with no allowed origin, which
        // is neither open nor closed — it just fails preflight. Nothing here is browser-facing:
        // the callers are the scheduler and the intake engine.
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        const method = req.method ?? 'GET';

        void (async () => {
            const started = Date.now();
            try {
                const body = method === 'POST' ? await readBody(req) : '';
                const header = req.headers['x-intake-token'];
                const token = Array.isArray(header) ? header[0] : header;
                const [status, payload] = await route(method, path, body, token);
                send(res, status, payload);
                log.debug('request', { method, path, status, ms: Date.now() - started });
            } catch (err) {
                if (err instanceof EngineError) {
                    const status = statusFor(err.kind);
                    // A not-yet-resolvable job is the NORMAL path for a relayer polling ahead of
                    // time. Logging it at warn would fill the log with successes.
                    const level = err.kind === 'too-early' ? 'debug' : 'warn';
                    log[level]('request refused', { method, path, kind: err.kind, status });
                    send(res, status, { error: err.message, kind: err.kind });
                    return;
                }
                log.error('request failed', { method, path, reason: errorMessage(err) });
                send(res, 500, { error: errorMessage(err) });
            }
        })();
    });
}
