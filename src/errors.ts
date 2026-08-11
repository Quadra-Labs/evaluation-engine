/**
 * errors.ts — why a settlement could not be produced, in the one dimension callers act on.
 *
 * The Sui engine returned HTTP 400 for everything (`EnclaveError::GenericError` -> 400, the only
 * status in the codebase), so a transient Pyth outage and a malformed job were indistinguishable
 * to the scheduler driving it. The scheduler's only sane response was to retry both or neither.
 *
 * These four kinds exist because a caller does something DIFFERENT for each:
 *
 *   `not-found`   — the id is wrong, or outside the scanned range. Do not retry.
 *   `too-early`   — correct, just not yet. Retry later; this is the normal path for a job whose
 *                   lifetime has not ended, and it must never look like a failure in a log.
 *   `terminal`    — already scored, already settled, already released. Stop, and stop permanently.
 *   `unsupported` — this build cannot score that evaluator. Do not retry; a newer image might.
 *   `upstream`    — the DA layer or the RPC failed. Retry; nothing is wrong with the request.
 *
 * Note what is NOT here: an agent delivering nonsense is not an error at all. It scores zero and
 * settles, because refusing to settle would let a bad delivery strand the escrow.
 */

export type EngineErrorKind = 'not-found' | 'too-early' | 'terminal' | 'unsupported' | 'upstream';

export class EngineError extends Error {
    constructor(
        readonly kind: EngineErrorKind,
        message: string,
    ) {
        super(message);
        this.name = 'EngineError';
    }
}

export const notFound = (message: string) => new EngineError('not-found', message);
export const tooEarly = (message: string) => new EngineError('too-early', message);
export const terminal = (message: string) => new EngineError('terminal', message);
export const unsupported = (message: string) => new EngineError('unsupported', message);
export const upstream = (message: string) => new EngineError('upstream', message);

/** The HTTP status a kind maps to. Kept here so the FCC and HTTP surfaces cannot drift. */
export function statusFor(kind: EngineErrorKind): number {
    switch (kind) {
        case 'not-found':
            return 404;
        case 'too-early':
        case 'terminal':
            return 409;
        case 'unsupported':
            return 400;
        case 'upstream':
            return 502;
    }
}
