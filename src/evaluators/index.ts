/**
 * evaluators/index.ts — what this build can score, and what it can actually SETTLE.
 *
 * Those are two different questions and conflating them is how a settlement gets signed that no
 * contract will accept. Scoring is arithmetic over a decrypted submission. Settling additionally
 * requires an FTSO anchor-feed Merkle proof whose normalized value equals the signed
 * `groundTruthValue`, because `JobEscrow.scoreJob`, `scoreJobFromTee`, `SealedCompetition.settle`
 * and `settleFromTee` all call `FtsoLib.checkGroundTruth`, and `ftsoVerifier` is `immutable` and
 * points at the real FtsoV2 on the live deployment.
 *
 * So the table below has three tiers, and the third is not a gap in this file:
 *
 *   PRICE      price-range-guess, up-down-guess, movement-percentage-guess.
 *              One feed, one proof, a [0,100] score. Jobs and competitions both.
 *              The scorers live in quadra-core, so the verifier replays them from the same code.
 *
 *   PORTFOLIO  portfolio-roi.
 *              A uint64 metric around 1e6, which fits `EntryInput.score` and `KIND_PERFORMANCE`
 *              but NOT `scoreJob`'s uint8 — so competitions only. The settlement pins ONE of the
 *              portfolio's feeds; the rest rest on the TEE signature alone.
 *
 *   MARKET     polymarket-resolution, polymarket-event, polymarket-price.
 *              Scoreable and NOT settleable. A Polymarket outcome has no FTSO feed, so there is
 *              no proof to attach. The engine refuses rather than attaching an unrelated feed's
 *              proof — that would satisfy the contract and be a lie, and it would be a lie the
 *              verifier would faithfully confirm. The real fix is an FDC `Web2Json` verification
 *              path in `contracts`, which is a different repo and a redeploy.
 */

import { isEvaluatorId } from 'quadra-core';
import { unsupported } from '../errors.js';
import {
    fetchEventMarkets,
    fetchMarket,
    priceAt,
    winnerOf,
    yesTokenId,
    PolymarketError,
} from './polymarket/client.js';
import { parseGuesses, scoreEvent, scorePrice, scoreResolution } from './polymarket/score.js';

export const PORTFOLIO_EVALUATOR = 'portfolio-roi';

export const POLYMARKET_RESOLUTION = 'polymarket-resolution';
export const POLYMARKET_EVENT = 'polymarket-event';
export const POLYMARKET_PRICE = 'polymarket-price';

export const POLYMARKET_EVALUATORS: readonly string[] = [
    POLYMARKET_RESOLUTION,
    POLYMARKET_EVENT,
    POLYMARKET_PRICE,
];

export type EvaluatorTier =
    | { readonly tier: 'price' }
    | { readonly tier: 'portfolio' }
    | { readonly tier: 'market' }
    | { readonly tier: 'unknown' };

export function evaluatorTier(evaluatorId: string): EvaluatorTier {
    if (isEvaluatorId(evaluatorId)) return { tier: 'price' };
    if (evaluatorId === PORTFOLIO_EVALUATOR) return { tier: 'portfolio' };
    if (POLYMARKET_EVALUATORS.includes(evaluatorId)) return { tier: 'market' };
    return { tier: 'unknown' };
}

/**
 * Refuse, with the whole reason, when an evaluator can be scored but not settled.
 *
 * The message is long on purpose. "unsupported evaluator" sends a reader looking for a missing
 * scorer that is in fact right there; the actual blocker is three repos away.
 */
export function assertSettleable(evaluatorId: string, isJob: boolean): void {
    const tier = evaluatorTier(evaluatorId);

    if (tier.tier === 'market') {
        throw unsupported(
            `"${evaluatorId}" can be scored but not settled. Every settlement path calls ` +
                `FtsoLib.checkGroundTruth, which needs an FTSO anchor-feed proof matching the ` +
                `signed groundTruthValue, and a prediction-market outcome has no FTSO feed. ` +
                `Settling it needs an FDC Web2Json verification path in contracts/ and a redeploy; ` +
                `attaching an unrelated feed's proof would pass on chain and be a lie.`,
        );
    }

    if (tier.tier === 'portfolio' && isJob) {
        throw unsupported(
            `"${evaluatorId}" produces a uint64 metric around ${1_000_000}, and JobEscrow.scoreJob ` +
                `takes a uint8 that Passport.record reverts above 100. It can only settle as a ` +
                `KIND_PERFORMANCE competition.`,
        );
    }

    if (tier.tier === 'unknown') {
        throw unsupported(`this build has no evaluator called "${evaluatorId}"`);
    }
}

// --- prediction markets ---------------------------------------------------------------------------

export interface MarketScoreArgs {
    readonly evaluatorId: string;
    readonly revealed: Record<string, string>;
    /** From the job's `params` or the competition's configuration: marketId, eventId, targetTs. */
    readonly params: Record<string, string>;
    readonly nowSecs: number;
}

/**
 * Score a prediction-market submission.
 *
 * Reachable through the scoring endpoints but never through a settlement — `assertSettleable`
 * stops that first. It exists so the evaluators are real and testable rather than stubs waiting on
 * a contract change, and so the day the FDC path lands the scoring half is already done.
 *
 * An agent fault is a zero, as everywhere else. An UPSTREAM failure throws, because a Polymarket
 * outage is not the agent being wrong.
 */
export async function scoreMarket(args: MarketScoreArgs): Promise<number> {
    switch (args.evaluatorId) {
        case POLYMARKET_RESOLUTION: {
            const marketId = args.params['marketId'] ?? args.params['market_id'];
            if (!marketId) throw unsupported('polymarket-resolution needs a "marketId" param');
            const market = await fetchMarket(marketId);
            const winner = winnerOf(market);
            if (winner === undefined) {
                throw new PolymarketError('unresolved', `market ${marketId} is not resolved yet`);
            }
            return scoreResolution(args.revealed['outcome'] ?? '', winner);
        }

        case POLYMARKET_EVENT: {
            const eventId = args.params['eventId'] ?? args.params['event_id'];
            if (!eventId) throw unsupported('polymarket-event needs an "eventId" param');
            const markets = await fetchEventMarkets(eventId);
            const winners = new Map<string, string>();
            for (const market of markets) {
                const winner = winnerOf(market);
                if (winner !== undefined) winners.set(market.id, winner);
            }
            const guesses = parseGuesses(args.revealed['guesses']);
            // An unparseable guess list is the agent's doing: score 0 rather than refusing to
            // settle, exactly as a malformed price band would.
            if (!guesses) return 0;
            // The denominator is the WHOLE event, so partial coverage caps the score.
            return scoreEvent(guesses, winners, markets.length);
        }

        case POLYMARKET_PRICE: {
            const marketId = args.params['marketId'] ?? args.params['market_id'];
            const targetRaw = args.params['targetTs'] ?? args.params['target_ts'];
            if (!marketId) throw unsupported('polymarket-price needs a "marketId" param');
            const targetTs = Number(targetRaw);
            if (!Number.isFinite(targetTs) || targetTs <= 0) {
                throw unsupported('polymarket-price needs a "targetTs" in unix seconds');
            }
            if (targetTs > args.nowSecs) {
                throw unsupported(
                    `targetTs ${targetTs} is in the future, so it is not resolvable yet`,
                );
            }
            const market = await fetchMarket(marketId);
            const token = yesTokenId(market);
            if (!token) {
                throw new PolymarketError('decode', `market ${marketId} has no YES token id`);
            }
            const actual = await priceAt(token, targetTs);
            const guess = Number(args.revealed['probability'] ?? args.revealed['price'] ?? '');
            if (!Number.isFinite(guess)) return 0;
            return scorePrice(guess, actual);
        }

        default:
            throw unsupported(`"${args.evaluatorId}" is not a prediction-market evaluator`);
    }
}

export { computeMetric, parsePortfolioSubmission, assetsOf, PERF_BASE } from './portfolioRoi.js';
export type { PortfolioSubmission, PortfolioVerdict, Trade } from './portfolioRoi.js';
export {
    fetchMarket,
    fetchEventMarkets,
    priceAt,
    winnerOf,
    yesTokenId,
    PolymarketError,
} from './polymarket/client.js';
export {
    scoreResolution,
    scoreEvent,
    scorePrice,
    parseGuesses,
    outcomeEq,
    type Guess,
} from './polymarket/score.js';
