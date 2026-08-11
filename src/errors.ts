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

/** Listed as a value too, so `decodeFailureKind` cannot fall out of step with the type. */
export const KINDS = ['not-found', 'too-early', 'terminal', 'unsupported', 'upstream'] as const;

export type EngineErrorKind = (typeof KINDS)[number];

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

/**
 * The kind, on a surface that has room for only ONE string.
 *
 * The HTTP service answers `{error, kind}` and a caller reads the field. FCC has no such luxury:
 * `HandlerResult` is `[data, status, error]` and the error slot is a single string that Flare's
 * envelope defines, not ours (`fcc/base/types.ts` — the JSON is what the node signs, so the shape
 * is fixed). So the kind goes in as a PREFIX, and the prefix is a CONTRACT rather than incidental
 * formatting: a relayer reads everything before the first colon and never matches on the prose
 * after it.
 *
 * That distinction is the whole point of these kinds. The Sui scheduler classified failures with a
 * regex over the enclave's message text (`too late|before started_at|missing field|...`), which had
 * to be kept in sync by hand across two repos and silently dropped a paid job whenever it drifted.
 * Reintroducing message matching on the FCC path would bring that back one layer down.
 *
 * `terminal` and `unsupported` are the two a relayer must NEVER re-arm. A `polymarket-*`
 * competition answers `unsupported` on every attempt for as long as this image runs (BUGS.md 26),
 * and it is a correct, final answer — not a transient one that a backoff eventually beats.
 */
export const KIND_SEPARATOR = ': ';

export function encodeFailure(err: EngineError): string {
    return `${err.kind}${KIND_SEPARATOR}${err.message}`;
}

/** The inverse, for a caller reading an FCC error slot. `undefined` means it carries no kind. */
export function decodeFailureKind(text: string): EngineErrorKind | undefined {
    const head = text.slice(0, text.indexOf(':'));
    return (KINDS as readonly string[]).includes(head) ? (head as EngineErrorKind) : undefined;
}

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
