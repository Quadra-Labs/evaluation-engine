/**
 * fetch.ts — the only way this workload reaches the network.
 *
 * Three properties, each of which the Sui engine and the Flare reference were missing at least one
 * of:
 *
 *   1. A TIMEOUT on every request. The Sui engine set 10s on Pyth and 20s on Polymarket and none on
 *      anything else. A settlement that hangs holds a job open past its deadline.
 *   2. A BYTE CAP on every response. This is the one worth stating plainly: for a workload meant to
 *      run inside a confidential enclave, unbounded egress is a finding rather than a feature. A
 *      hostile or broken upstream that streams forever otherwise exhausts the container's memory,
 *      and `res.json()` cannot be capped after the fact — by the time it resolves the bytes are
 *      already in the process.
 *   3. RETRY on transient failures ONLY. `isTransient` comes from quadra-core so the engine, the
 *      indexer and the verifier agree on what deserves a second attempt. Retrying a 400 is how a
 *      rate limit becomes a ban.
 *
 * `TooLarge` is deliberately NOT transient: a response over the cap will be over the cap again.
 */

import { isTransient, withRetry } from 'quadra-core';

export interface FetchLimits {
    readonly timeoutMs: number;
    readonly maxBytes: number;
    /** Total attempts including the first. 1 disables retry. */
    readonly attempts: number;
}

export const DEFAULT_LIMITS: FetchLimits = { timeoutMs: 15_000, maxBytes: 2_000_000, attempts: 3 };

/** The upstream answered, but with more bytes than we are willing to hold. Never retried. */
export class ResponseTooLargeError extends Error {
    constructor(url: string, maxBytes: number) {
        super(`response from ${url} exceeded the ${maxBytes} byte cap`);
        this.name = 'ResponseTooLargeError';
    }
}

/** The upstream answered with a non-2xx status. Transient-or-not is decided by `isTransient`. */
export class HttpStatusError extends Error {
    constructor(
        readonly status: number,
        url: string,
        readonly body: string,
    ) {
        super(`${url} returned status ${status}`);
        this.name = 'HttpStatusError';
    }
}

function limitsFromEnv(): FetchLimits {
    const timeoutMs = Number(process.env['HTTP_TIMEOUT_MS'] ?? DEFAULT_LIMITS.timeoutMs);
    const maxBytes = Number(process.env['HTTP_MAX_BYTES'] ?? DEFAULT_LIMITS.maxBytes);
    return {
        timeoutMs:
            Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LIMITS.timeoutMs,
        maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_LIMITS.maxBytes,
        attempts: DEFAULT_LIMITS.attempts,
    };
}

/**
 * Read a body with a hard ceiling.
 *
 * The `content-length` header is used to refuse early but never to CONCLUDE a body is small — it is
 * supplied by the upstream and a chunked response omits it entirely, so the counting reader below
 * is what actually enforces the cap.
 */
async function readCapped(res: Response, url: string, maxBytes: number): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new ResponseTooLargeError(url, maxBytes);
    }

    const body = res.body;
    if (!body) return '';

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new ResponseTooLargeError(url, maxBytes);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function once(
    url: string,
    init: RequestInit | undefined,
    limits: FetchLimits,
): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const text = await readCapped(res, url, limits.maxBytes);
        if (!res.ok) throw new HttpStatusError(res.status, url, text.slice(0, 512));
        return text;
    } finally {
        clearTimeout(timer);
    }
}

/** A capped, timed-out, transiently-retried request returning the raw body. */
export async function fetchText(
    url: string,
    init?: RequestInit,
    overrides?: Partial<FetchLimits>,
): Promise<string> {
    const limits = { ...limitsFromEnv(), ...overrides };
    return withRetry(async () => {
        try {
            return await once(url, init, limits);
        } catch (err) {
            // A cap breach and a 4xx are both permanent. Rethrowing them through withRetry's
            // transient check would burn the whole attempt budget on a request that cannot succeed.
            if (err instanceof ResponseTooLargeError) throw err;
            if (err instanceof HttpStatusError && !isTransient(err)) throw err;
            throw err;
        }
    }, limits.attempts);
}

/** The same, parsed as JSON. Parse failure is a fault of the upstream, not a transient blip. */
export async function fetchJson<T>(
    url: string,
    init?: RequestInit,
    overrides?: Partial<FetchLimits>,
): Promise<T> {
    const text = await fetchText(url, init, overrides);
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`${url} did not return valid JSON`);
    }
}

/**
 * A `FetchLike` for quadra-core's ground-truth fetcher, which accepts an injected fetch so the
 * enclave can impose these limits on the DA layer without quadra-core taking a dependency on this
 * module (it must stay I/O-free and native-dependency-free — it compiles into the measured image).
 *
 * It only ever resolves `ok: true`. quadra-core would turn a false into
 * `ground-truth: DA layer returned <n>`, which loses the upstream's own body; `fetchText` has
 * already thrown a `HttpStatusError` carrying it, and that is the more useful error.
 */
export function cappedFetchImpl(overrides?: Partial<FetchLimits>) {
    return async (url: string, init: RequestInit) => {
        const text = await fetchText(url, init, overrides);
        return {
            ok: true,
            status: 200,
            json: async () => JSON.parse(text) as unknown,
        };
    };
}
