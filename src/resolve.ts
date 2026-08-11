/**
 * resolve.ts — which price feed, over which window, an item is scored against.
 *
 * The fetching itself is quadra-core's (`resolveInputs` hits the DA layer twice, once for the
 * round covering resolution and once for the round one lifetime earlier). What lives here is the
 * POLICY: how the engine decides which feed and which window, from what the chain says rather than
 * from what a caller claims.
 *
 * PAID JOBS know both exactly. The asset is in the `params` recorded in `JobPaid`, and the window
 * is `lifetimeEnd - paidAt` — two values written when the buyer paid, long before anyone asked for
 * a score.
 *
 * COMPETITIONS NOW KNOW BOTH TOO. `SealedCompetition.create` records `params` — the same
 * JSON-in-hex blob a job carries, so `jobAsset()` reads either — and `lifetimeSecs`, the window the
 * entries are scored over. Both are written when the competition is opened, so neither the enclave
 * nor whoever asks for the settlement has any say in them.
 *
 * That is new. Until plan/09 feature 44 a competition recorded only an `evaluatorId` and a
 * `resolveAt`, and the two missing values were substituted from the engine's own configuration:
 * `DEFAULT_FEED` and `DEFAULT_LIFETIME_SECS`. Both are in the image's env-override allow-list, so
 * an operator could change what every competition was measured by, and over how long, without
 * changing the code hash — and an ETH competition was graded against the BTC feed. The Flare
 * reference went further still, hardcoding `feedForEvaluator: () => config.defaultFeed` with no
 * warning at all.
 *
 * The fallback chain remains, because an empty `params` is legal and means "no asset declared":
 *
 *   - the competition's own asset wins (`feedFor` in quadra-core);
 *   - then `feedForEvaluator` looks for a known feed asset inside the evaluator id, so an evaluator
 *     family that names its asset (`price-range-guess-eth`) resolves correctly;
 *   - only when neither names anything does it fall back to `DEFAULT_FEED`, and it WARNS.
 */

import { FEED_IDS, isFeedSymbol, jobAsset } from 'quadra-core';
import {
    resolveInputs,
    type ResolveConfig,
    type ResolvedGroundTruth,
} from 'quadra-core/ground-truth';
import type { Hex } from 'viem';
import { cappedFetchImpl } from './http/fetch.js';
import { log } from './log.js';

export type FeedSymbol = keyof typeof FEED_IDS;

export interface ResolvedWindow {
    readonly end: ResolvedGroundTruth;
    readonly startValue: bigint;
    readonly lifetimeSecs: number;
}

/** Whether this build can price an asset at all, i.e. whether an FTSO anchor feed covers it. */
export function hasAnchorFeed(asset: string): boolean {
    return isFeedSymbol(`${asset.toUpperCase()}/USD`);
}

/**
 * Ceiling on the distinct assets one settlement will price.
 *
 * Each asset costs TWO sequential DA-layer round trips, so this is the number that bounds how long
 * a settlement can take and how much of a rate-limited public endpoint it consumes.
 *
 * IT CANNOT FIRE TODAY and that is deliberate. `FEED_IDS` carries five symbols and an asset outside
 * it is refused one layer up, so the union is already bounded by the feed table — the operative
 * bound is 5, which is why the request count was never actually the live half of BUGS.md 31. This
 * exists so that a feed table which grows to fifty does not silently turn one settlement into a
 * hundred sequential requests. Over the cap the tail is dropped in SORTED order, so which assets go
 * unpriced is deterministic and replayable rather than arrival-dependent, and an entrant holding one
 * of them scores the flat baseline exactly as an unparseable submission does.
 */
export const MAX_PORTFOLIO_ASSETS = 16;

/**
 * A memo over resolved windows, for the life of one engine process.
 *
 * The point is RETRIES. A settlement that fails on the tenth asset — a DA-layer blip, a revert
 * relaying the result, a restarted relayer — otherwise re-fetches the nine that already answered,
 * and each of those is two rate-limited round trips.
 *
 * Caching is safe here for a reason worth stating rather than assuming: every key names a
 * FINALIZED voting round, and a finalized round's reading is immutable history. There is no
 * staleness to expire, so there is no TTL. What is bounded is memory: oldest-first eviction at
 * `maxEntries`, which is a plain FIFO because a settlement reads each key once and the access
 * pattern gives an LRU nothing to work with.
 */
export interface PriceCache {
    get(key: string): ResolvedWindow | undefined;
    set(key: string, value: ResolvedWindow): void;
    readonly size: number;
}

export function makePriceCache(maxEntries = 128): PriceCache {
    const entries = new Map<string, ResolvedWindow>();
    return {
        get: (key) => entries.get(key),
        set(key, value) {
            if (entries.has(key)) return;
            if (entries.size >= maxEntries) {
                const oldest = entries.keys().next();
                if (!oldest.done) entries.delete(oldest.value);
            }
            entries.set(key, value);
        },
        get size() {
            return entries.size;
        },
    };
}

export interface ResolvePolicy {
    readonly daBaseUrl: string;
    readonly daApiKey: string | undefined;
    readonly defaultFeed: string;
    readonly defaultLifetimeSecs: number;
    /** Resolved from `FlareSystemsManager` at boot; omitted uses quadra-core's Coston2 fallback. */
    readonly votingEpoch?: ResolveConfig['votingEpoch'];
}

/**
 * The feed an evaluator id names, if it names one.
 *
 * Tokenised on the separators an id actually uses so `price-range-guess-eth`, `eth_price_range`
 * and `btc/price-range` all resolve. Returns undefined rather than guessing.
 */
export function feedFromEvaluatorId(evaluatorId: string): FeedSymbol | undefined {
    for (const token of evaluatorId.split(/[^A-Za-z0-9]+/)) {
        if (!token) continue;
        const symbol = `${token.toUpperCase()}/USD`;
        if (isFeedSymbol(symbol)) return symbol as FeedSymbol;
    }
    return undefined;
}

function makeConfig(policy: ResolvePolicy, warnOnFallback: boolean): ResolveConfig {
    const fallbackFeed = policy.defaultFeed;
    if (!isFeedSymbol(fallbackFeed)) {
        throw new Error(
            `DEFAULT_FEED "${fallbackFeed}" is not a feed this build knows: ` +
                `${Object.keys(FEED_IDS).join(', ')}`,
        );
    }

    return {
        daBaseUrl: policy.daBaseUrl,
        defaultLifetimeSecs: policy.defaultLifetimeSecs,
        apiKey: policy.daApiKey,
        // The DA layer is reached through the capped, timed-out, retrying fetch rather than the
        // global one. quadra-core takes an injected fetch precisely so it can stay I/O-policy-free
        // and still compile into the measured image.
        fetchImpl: cappedFetchImpl(),
        votingEpoch: policy.votingEpoch,
        feedForEvaluator: (evaluatorId: string) => {
            const named = feedFromEvaluatorId(evaluatorId);
            if (named) return named;
            if (warnOnFallback) {
                log.warn('nothing named an asset, scoring against DEFAULT_FEED', {
                    evaluatorId,
                    defaultFeed: fallbackFeed,
                    note:
                        'the item declared no asset in its params and the evaluator id names ' +
                        'none either — open competitions with PARAMS_JSON to avoid this',
                });
            }
            return fallbackFeed as FeedSymbol;
        },
    };
}

/**
 * `resolveInputs`, through the cache when one is supplied.
 *
 * The key is exactly the inputs `resolveInputs` is a pure function of — the same evaluator, asset,
 * instant and window resolve the same voting rounds, and a finalized round answers the same reading
 * forever. `daBaseUrl` and the epoch geometry are not in the key because they are fixed for the life
 * of a `ResolvePolicy`, and a cache is only ever handed to one engine.
 */
async function resolveCached(
    config: ResolveConfig,
    cache: PriceCache | undefined,
    evaluatorId: string,
    resolveAtSecs: number,
    asset?: string,
    windowSecs?: number,
): Promise<ResolvedWindow> {
    const key = `${evaluatorId}|${asset ?? ''}|${resolveAtSecs}|${windowSecs ?? ''}`;
    const hit = cache?.get(key);
    if (hit) return hit;
    const resolved = await resolveInputs(config, evaluatorId, resolveAtSecs, asset, windowSecs);
    cache?.set(key, resolved);
    return resolved;
}

/**
 * A paid job's window. `params` and `paidAtSecs` both come from the `JobPaid` log, so neither the
 * agent nor the relayer asking for the score has any say in what it is measured against.
 */
export async function resolveForJob(
    policy: ResolvePolicy,
    args: {
        readonly evaluatorId: string;
        readonly params: Hex;
        readonly paidAtSecs: number;
        readonly lifetimeEndSecs: number;
        readonly cache?: PriceCache | undefined;
    },
): Promise<ResolvedWindow> {
    const asset = jobAsset(args.params);
    const windowSecs = args.lifetimeEndSecs - args.paidAtSecs;
    if (windowSecs <= 0) {
        throw new Error(
            `job window is not positive: paid at ${args.paidAtSecs}, lifetime ends ` +
                `${args.lifetimeEndSecs}`,
        );
    }
    // A job DOES name its asset, so a fallback here would be a real defect rather than a contract
    // limitation — warn on it.
    return resolveCached(
        makeConfig(policy, true),
        args.cache,
        args.evaluatorId,
        args.lifetimeEndSecs,
        asset,
        windowSecs,
    );
}

/**
 * A competition's window: `[resolveAt - lifetimeSecs, resolveAt]`, against the asset its `params`
 * declare.
 *
 * There is still no per-entrant start — everyone in a competition is scored over the same window,
 * which is the fair reading of a market where everyone forecast the same horizon. What changed is
 * WHOSE window it is. `lifetimeSecs` is the competition's own, fixed when it was created and
 * readable by every entrant before they staked; it used to be `DEFAULT_LIFETIME_SECS`, an operator
 * setting nobody outside the enclave could see.
 *
 * `windowSecs` is passed through as-is. `create` rejects a zero window, so a zero reaching here
 * means a competition created against the OLD contract, and `resolveInputs` treats it as absent and
 * falls back to `defaultLifetimeSecs` — which is precisely what such a competition was scored over
 * when it was opened.
 */
export async function resolveForCompetition(
    policy: ResolvePolicy,
    args: {
        readonly evaluatorId: string;
        readonly resolveAtSecs: number;
        /** From the competition's `params`; undefined when it declared none. */
        readonly asset?: string | undefined;
        /** The competition's `lifetimeSecs`. */
        readonly windowSecs?: number | undefined;
        readonly cache?: PriceCache | undefined;
    },
): Promise<ResolvedWindow> {
    return resolveCached(
        makeConfig(policy, true),
        args.cache,
        args.evaluatorId,
        args.resolveAtSecs,
        args.asset,
        args.windowSecs,
    );
}

export interface ResolvedPortfolio {
    /** asset -> price at the window's start, in 1e-8 units. */
    readonly startPrices: ReadonlyMap<string, bigint>;
    readonly endPrices: ReadonlyMap<string, bigint>;
    /**
     * Every asset's resolved window, in the same sorted order as `startPrices`/`endPrices`.
     *
     * These become the settlement's parallel `feedIds` / `groundTruthValues` / `proofs` arrays, so
     * `FtsoLib.checkGroundTruths` cross-checks EVERY leg on chain rather than one.
     *
     * Before BUGS.md 27 this struct kept only `primary` and threw the rest away — the DA layer had
     * already been paid for them, and a settlement carried a single value and a single proof, so a
     * portfolio naming BTC, ETH and SOL had two thirds of its ground truth attested by the TEE
     * signature alone.
     */
    readonly windows: readonly { readonly asset: string; readonly window: ResolvedWindow }[];
    /**
     * The asset the SCORER measured against, and whose `startValue`/`lifetimeSecs` the receipt
     * records as primary. Still the first in sorted order, so the pick stays deterministic and
     * replayable rather than "whichever resolved first". It is no longer the only attested one.
     */
    readonly primary: ResolvedWindow;
    readonly primaryAsset: string;
}

/**
 * Every price pair a portfolio needs.
 *
 * Two DA-layer calls per asset, sequentially. Concurrency would be faster and is deliberately not
 * used: the DA layer is rate limited, and a settlement that gets throttled halfway through is worse
 * than one that takes a few more seconds. What bounds the total is `MAX_PORTFOLIO_ASSETS` above,
 * plus the memo, which is what stops a retry from paying for the whole set again.
 *
 * An asset with no anchor feed is still a hard failure here, but it is now an INVARIANT rather than
 * a policy: the caller has already excluded any entrant naming one (see `engine.ts`), so reaching
 * this throw means a bug in that filter, not a hostile submission. It stays because the alternative
 * is worse — `resolveInputs` would price an unknown asset with DEFAULT_FEED, which means valuing
 * someone's DOGE position at the BTC price and signing the result.
 *
 * Before BUGS.md 31 this throw WAS the policy, and it made settlement liveness an entrant's choice:
 * one address sealing a portfolio that named DOGE took the whole competition down with it, forever,
 * with the relayer retrying an error that could never clear.
 */
export async function resolveForPortfolio(
    policy: ResolvePolicy,
    args: {
        readonly evaluatorId: string;
        readonly assets: readonly string[];
        readonly resolveAtSecs: number;
        readonly windowSecs?: number | undefined;
        readonly cache?: PriceCache | undefined;
    },
): Promise<ResolvedPortfolio> {
    const distinct = [...new Set(args.assets)].sort();
    if (distinct.length === 0) throw new Error('a portfolio names no assets');

    for (const asset of distinct) {
        if (!hasAnchorFeed(asset)) {
            throw new Error(
                `no FTSO anchor feed for "${asset}" — this build knows ` +
                    `${Object.keys(FEED_IDS).join(', ')}`,
            );
        }
    }

    const sorted = distinct.slice(0, MAX_PORTFOLIO_ASSETS);
    if (distinct.length > sorted.length) {
        log.warn('more distinct assets than one settlement will price; the tail goes unvalued', {
            evaluatorId: args.evaluatorId,
            assets: distinct.length,
            maxAssets: MAX_PORTFOLIO_ASSETS,
            unpriced: distinct.slice(MAX_PORTFOLIO_ASSETS).join(','),
        });
    }

    // No fallback warning: an unknown asset already threw above, so the config can never fall back.
    const config = makeConfig(policy, false);
    const startPrices = new Map<string, bigint>();
    const endPrices = new Map<string, bigint>();
    const windows: { asset: string; window: ResolvedWindow }[] = [];

    for (const asset of sorted) {
        const resolved = await resolveCached(
            config,
            args.cache,
            args.evaluatorId,
            args.resolveAtSecs,
            asset,
            args.windowSecs,
        );
        startPrices.set(asset, resolved.startValue);
        endPrices.set(asset, resolved.end.value);
        // Kept, not discarded: each carries the feed proof that pins its leg on chain.
        windows.push({ asset, window: resolved });
    }

    const primaryAsset = sorted[0] as string;
    return {
        startPrices,
        endPrices,
        windows,
        primary: (windows[0] as { window: ResolvedWindow }).window,
        primaryAsset,
    };
}
