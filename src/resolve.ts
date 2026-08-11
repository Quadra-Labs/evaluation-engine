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
 * COMPETITIONS know neither. `SealedCompetition.create` records an `evaluatorId` and a `resolveAt`
 * and nothing about an asset, so there is no per-competition asset to read. This is a limit of the
 * deployed contract, not an omission here, and the honest response is to say so loudly rather than
 * silently substitute a default:
 *
 *   - `feedForEvaluator` looks for a known feed asset inside the evaluator id first, so an
 *     evaluator family that names its asset (`price-range-guess-eth`) resolves correctly the day
 *     one is registered.
 *   - Only when the id names nothing does it fall back to `DEFAULT_FEED`, and it WARNS. The
 *     Flare reference hardcoded `feedForEvaluator: () => config.defaultFeed` with no warning and
 *     no id inspection, so every competition scored against BTC/USD whatever it was about — and
 *     `DEFAULT_FEED` is in the image's env-override allow-list, meaning an operator could change
 *     what every competition was measured by without changing the code hash.
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
                log.warn('no asset in the evaluator id, scoring against DEFAULT_FEED', {
                    evaluatorId,
                    defaultFeed: fallbackFeed,
                    note: 'a competition carries no asset on chain; see resolve.ts',
                });
            }
            return fallbackFeed as FeedSymbol;
        },
    };
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
    return resolveInputs(
        makeConfig(policy, true),
        args.evaluatorId,
        args.lifetimeEndSecs,
        asset,
        windowSecs,
    );
}

/**
 * A competition's window. There is no per-entrant start, so `DEFAULT_LIFETIME_SECS` sizes the
 * scorer's tolerance for every entrant equally — which is the fair reading of a competition where
 * everyone forecast the same horizon.
 */
export async function resolveForCompetition(
    policy: ResolvePolicy,
    args: { readonly evaluatorId: string; readonly resolveAtSecs: number },
): Promise<ResolvedWindow> {
    return resolveInputs(makeConfig(policy, true), args.evaluatorId, args.resolveAtSecs);
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
 * used: the DA layer is rate limited, a portfolio can name a dozen assets, and a settlement that
 * gets throttled halfway through is worse than one that takes a few more seconds.
 *
 * An asset with no anchor feed is a hard failure rather than a fallback. `resolveInputs` would
 * otherwise price an unknown asset with DEFAULT_FEED, which means valuing someone's DOGE position
 * at the BTC price and signing the result.
 */
export async function resolveForPortfolio(
    policy: ResolvePolicy,
    args: {
        readonly evaluatorId: string;
        readonly assets: readonly string[];
        readonly resolveAtSecs: number;
        readonly windowSecs?: number | undefined;
    },
): Promise<ResolvedPortfolio> {
    const sorted = [...new Set(args.assets)].sort();
    if (sorted.length === 0) throw new Error('a portfolio names no assets');

    for (const asset of sorted) {
        if (!isFeedSymbol(`${asset}/USD`)) {
            throw new Error(
                `no FTSO anchor feed for "${asset}" — this build knows ` +
                    `${Object.keys(FEED_IDS).join(', ')}`,
            );
        }
    }

    // No fallback warning: an unknown asset already threw above, so the config can never fall back.
    const config = makeConfig(policy, false);
    const startPrices = new Map<string, bigint>();
    const endPrices = new Map<string, bigint>();
    const windows: { asset: string; window: ResolvedWindow }[] = [];

    for (const asset of sorted) {
        const resolved = await resolveInputs(
            config,
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
