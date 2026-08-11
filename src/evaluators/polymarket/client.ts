/**
 * client.ts — Polymarket's Gamma and CLOB APIs, ported from the Sui engine's
 * `apps/polymarket/client.rs`.
 *
 * This is a SECOND ORACLE CLASS and it is nothing like the first. FTSO anchor feeds come with a
 * Merkle proof the settlement contract re-verifies itself; these are plain HTTPS reads whose only
 * guarantee is that the enclave made them. That difference is the reason these evaluators cannot
 * settle today — see `evaluators/index.ts` — and the reason Flare's FDC `Web2Json` attestation
 * type is the eventual answer rather than this file.
 *
 * FOUR GAMMA QUIRKS THE PORT REPRODUCES, because the API really is shaped this way:
 *
 *   `outcomes`, `outcomePrices` and `clobTokenIds` arrive as JSON ENCODED INTO A STRING — the
 *   field value is the literal text `["Yes","No"]`, so it needs a second parse.
 *   `id` may be a string or a number.
 *   Single-object endpoints sometimes answer with a one-element array.
 *   `prices-history` points carry `t` and `p` that may each be a number or a numeric string.
 *
 * TWO TIE-BREAKS ARE PRESERVED EXACTLY, because changing either silently changes settled scores:
 * `winner()` takes the LAST maximal outcome price (Rust's `max_by` returns the last maximum), and
 * `priceAt` keeps the FIRST of two equally-close timestamps (a strict `<` comparison).
 *
 * All requests go through the capped, timed-out, retrying fetch. The Sui client set a 10s connect
 * and 20s total timeout and a browser-ish User-Agent because Polymarket fronts its API with
 * Cloudflare bot management; the User-Agent is kept for the same reason.
 */

import { fetchJson } from '../../http/fetch.js';

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';

const HEADERS = {
    'user-agent': 'Mozilla/5.0 (compatible; QuadraEvalEngine/1.0; +https://polymarket.com)',
    accept: 'application/json',
};

const LIMITS = { timeoutMs: 20_000 };

export class PolymarketError extends Error {
    constructor(
        readonly kind: 'request' | 'decode' | 'not-found' | 'unresolved',
        message: string,
    ) {
        super(message);
        this.name = 'PolymarketError';
    }
}

export interface Market {
    readonly id: string;
    readonly closed: boolean;
    readonly outcomes: readonly string[];
    readonly outcomePrices: readonly number[];
    readonly clobTokenIds: readonly string[];
}

async function getJson(url: string): Promise<unknown> {
    try {
        return await fetchJson<unknown>(url, { headers: HEADERS }, LIMITS);
    } catch (err) {
        throw new PolymarketError('request', err instanceof Error ? err.message : String(err));
    }
}

/** A field whose value is a JSON array encoded as a string. See the header. */
function stringArray(row: Record<string, unknown>, field: string): string[] {
    const raw = row[field];
    if (typeof raw !== 'string') {
        throw new PolymarketError('decode', `market field "${field}" is missing or not a string`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new PolymarketError('decode', `market field "${field}" is not a JSON array`);
    }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
        throw new PolymarketError('decode', `market field "${field}" is not an array of strings`);
    }
    return parsed as string[];
}

function numberOf(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function readId(row: Record<string, unknown>): string {
    const raw = row['id'];
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number') return String(raw);
    return '';
}

function marketFrom(value: unknown): Market {
    if (!value || typeof value !== 'object') {
        throw new PolymarketError('decode', 'market is not an object');
    }
    const row = value as Record<string, unknown>;
    const prices = stringArray(row, 'outcomePrices').map((text) => {
        const parsed = Number(text.trim());
        if (!Number.isFinite(parsed)) {
            throw new PolymarketError('decode', `outcomePrices entry "${text}" is not a number`);
        }
        return parsed;
    });
    return {
        id: readId(row),
        closed: row['closed'] === true,
        outcomes: stringArray(row, 'outcomes'),
        outcomePrices: prices,
        clobTokenIds: stringArray(row, 'clobTokenIds'),
    };
}

/** Unwrap either shape a single-object endpoint may answer with. */
function firstObject(value: unknown): unknown {
    if (Array.isArray(value)) {
        if (value.length === 0) throw new PolymarketError('not-found', 'empty array');
        return value[0];
    }
    return value;
}

/**
 * The resolved winning outcome, or undefined when the market is not cleanly resolved.
 *
 * Requires BOTH `closed` and a decisive price (>= 0.99). A closed but indecisive market — a 50/50
 * that was voided, say — reads as unresolved rather than picking a winner, which is what stops a
 * settlement from inventing an outcome nobody agreed on.
 */
export function winnerOf(market: Market): string | undefined {
    if (!market.closed || market.outcomes.length === 0) return undefined;

    let bestIndex = -1;
    let best = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < market.outcomePrices.length; i += 1) {
        const price = market.outcomePrices[i];
        if (price === undefined) continue;
        // `>=` so the LAST maximum wins, matching Rust's `max_by`.
        if (price >= best) {
            best = price;
            bestIndex = i;
        }
    }
    if (bestIndex < 0 || best < 0.99) return undefined;
    return market.outcomes[bestIndex];
}

/** The YES outcome's index, case-insensitively, defaulting to 0 for a binary market. */
export function yesIndex(market: Market): number {
    const found = market.outcomes.findIndex((o) => o.trim().toLowerCase() === 'yes');
    return found === -1 ? 0 : found;
}

export function yesTokenId(market: Market): string | undefined {
    return market.clobTokenIds[yesIndex(market)];
}

export async function fetchMarket(id: string): Promise<Market> {
    return marketFrom(
        firstObject(await getJson(`${GAMMA_HOST}/markets/${encodeURIComponent(id)}`)),
    );
}

export async function fetchEventMarkets(id: string): Promise<Market[]> {
    const event = firstObject(await getJson(`${GAMMA_HOST}/events/${encodeURIComponent(id)}`));
    const markets = (event as Record<string, unknown> | null)?.['markets'];
    if (!Array.isArray(markets)) {
        throw new PolymarketError('not-found', `event "${id}" has no markets array`);
    }
    return markets.map(marketFrom);
}

/**
 * The YES token's price nearest `targetTs` (unix SECONDS), from a +/-1h window at 1-minute
 * fidelity. Ties keep the FIRST point seen — see the header.
 */
export async function priceAt(tokenId: string, targetTs: number): Promise<number> {
    const start = Math.max(0, targetTs - 3_600);
    const end = targetTs + 3_600;
    const url =
        `${CLOB_HOST}/prices-history?market=${encodeURIComponent(tokenId)}` +
        `&startTs=${start}&endTs=${end}&fidelity=1`;

    const body = await getJson(url);
    const history = (body as Record<string, unknown> | null)?.['history'];
    if (!Array.isArray(history)) {
        throw new PolymarketError('decode', 'prices-history has no "history" array');
    }

    let bestPrice: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const point of history) {
        if (!point || typeof point !== 'object') continue;
        const row = point as Record<string, unknown>;
        const t = numberOf(row['t']);
        const p = numberOf(row['p']);
        if (t === undefined || p === undefined) continue;
        const distance = Math.abs(t - targetTs);
        // Strict `<`, so the first of two equally-close points wins.
        if (distance < bestDistance) {
            bestDistance = distance;
            bestPrice = p;
        }
    }

    if (bestPrice === undefined) {
        throw new PolymarketError('unresolved', `no price for token ${tokenId} near ${targetTs}`);
    }
    return bestPrice;
}
