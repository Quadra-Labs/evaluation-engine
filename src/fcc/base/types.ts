/**
 * types.ts — the FCC action/result wire types.
 *
 * Ported from Flare's `fce-extension-scaffold`. NOT OURS TO REDESIGN: the `ActionResult` this
 * produces is serialized to JSON and that JSON is what the TEE node hashes and signs, so field
 * order, field presence and the absence of whitespace are all load-bearing. A field omitted
 * because it was empty changes the bytes, changes the hash, and produces a signature the contract
 * recovers to the wrong address — with no diagnostic anywhere.
 *
 * ONE ASYMMETRY THAT LOOKS LIKE A BUG AND IS NOT. `ActionResult.version` is a PLAIN STRING while
 * `StateResponse.stateVersion` is a BYTES32 HEX. Flare's Go declares them as `Version string` and
 * `StateVersion common.Hash`, and the scaffold's `/state` handler passes the version through
 * `teeutils.ToHash`. The reference ports to Python and TypeScript both get this wrong in the same
 * direction, so it is worth stating rather than "tidying".
 *
 * DISPATCH IS ON 32 BYTES. `opType` and `opCommand` are `bytes32("...")` on the Solidity side:
 * UTF-8, right-zero-padded. Comparison is on the full padded value, never on a readable rendering
 * of it. A mismatch is not an error anywhere — the instruction is accepted on chain and simply
 * never delivered, which is indistinguishable from a slow voting round.
 */

import { stringToBytes32Hex } from './encoding.js';

/** `[dataHex, status, error]`. `status`: 0 error, 1 success, >=2 still processing. */
export type HandlerResult = [string | null, number, string | null];

export type HandlerFunc = (originalMessage: string) => HandlerResult | Promise<HandlerResult>;

export type ReportStateFunc = () => unknown;

export type RegisterFunc = (framework: Framework) => void;

/** `bytes32("")` — 32 zero bytes. The wildcard opCommand. */
export const EMPTY_BYTES32 = stringToBytes32Hex('');

export const STATUS_ERROR = 0;
export const STATUS_SUCCESS = 1;
export const STATUS_PENDING = 2;

export interface DataFixed {
    readonly instructionId?: string;
    readonly teeId?: string;
    readonly timestamp?: number;
    readonly rewardEpochId?: number;
    readonly opType: string;
    readonly opCommand: string;
    readonly cosigners?: string[];
    readonly cosignersThreshold?: number;
    /** The instruction payload. For every Quadra verb this is `abi.encode(bytes32 subjectId)`. */
    readonly originalMessage?: string;
    readonly additionalFixedMessage?: string;
}

export interface ActionData {
    readonly id: string;
    readonly type: string;
    readonly submissionTag: string;
    /** Hex of the UTF-8 JSON of a `DataFixed`. */
    readonly message: string;
}

export interface Action {
    readonly data: ActionData;
    readonly additionalVariableMessages?: string[];
    readonly timestamps?: number[];
    readonly additionalActionData?: unknown;
    readonly signatures?: unknown;
}

export interface ActionResult {
    readonly id: string;
    readonly submissionTag: string;
    readonly status: number;
    readonly log: string;
    readonly opType: string;
    readonly opCommand: string;
    readonly additionalResultStatus: string;
    readonly version: string;
    readonly data: string;
}

export interface StateResponse {
    /** bytes32 hex, NOT the plain string `version` is. See the header. */
    readonly stateVersion: string;
    readonly state: unknown;
}

/**
 * The handler table.
 *
 * Exact `(opType, opCommand)` match first, then a wildcard registered under the empty opCommand.
 * Quadra registers three exact pairs and no wildcard: a verb this build does not implement should
 * answer 501 rather than being silently absorbed by a catch-all.
 */
export class Framework {
    private readonly handlers = new Map<string, HandlerFunc>();

    private static key(opType: string, opCommand: string): string {
        return `${opType.toLowerCase()}:${opCommand.toLowerCase()}`;
    }

    handle(opType: string, opCommand: string, handler: HandlerFunc): void {
        this.handlers.set(Framework.key(opType, opCommand), handler);
    }

    lookup(opType: string, opCommand: string): HandlerFunc | null {
        return (
            this.handlers.get(Framework.key(opType, opCommand)) ??
            this.handlers.get(Framework.key(opType, EMPTY_BYTES32)) ??
            null
        );
    }
}

/**
 * The `log` field is contractual, not free text: the node reads it to decide how to report the
 * action. Only these three shapes are correct.
 */
export function logFor(status: number, error: string | null): string {
    if (status === STATUS_ERROR) return `error: ${error ?? 'unknown'}`;
    if (status === STATUS_SUCCESS) return 'ok';
    return 'pending';
}

/**
 * `StateResponse.stateVersion`, which is `teeutils.ToHash(config.Version)` on the Go side — the
 * version string as bytes32, not the string itself. See the asymmetry note in the header.
 */
export function stateVersionOf(version: string): string {
    return stringToBytes32Hex(version);
}
