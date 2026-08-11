/**
 * score.ts — the confidential core: plaintext in, a receipt and a score out.
 *
 * Split into `build*` (pure, no signing, no I/O) and `sign*` deliberately. The FCC path signs an
 * ActionResult through Flare's node while the EIP-712 path signs a typed-data digest with a local
 * key, and the scoring must not fork between them — a difference of one point between the two
 * paths would be a difference nobody could explain and the verifier would call tampering. The
 * `build*` functions are what both paths share, and they are what a local test can exercise with
 * no chain and no key.
 *
 * FOUR RULES.
 *
 * AN AGENT FAULT IS A ZERO, NOT AN EXCEPTION. A submission that will not decrypt, or decrypts to
 * nonsense, scores zero and settles. Throwing would let one hostile entry hold a whole
 * competition's prize pool hostage. The reason is recorded in the receipt entry so the zero is
 * explicable rather than mysterious.
 *
 * AN ORACLE FAULT IS AN EXCEPTION. A non-positive start price is NOT the agent's doing, and
 * scoring it zero would punish an agent for the DA layer having a bad round. quadra-core's scorer
 * classifies it as an agent fault and admits in its own comment that the classification is wrong;
 * the guard below catches it first so the settlement fails loudly instead of quietly zeroing
 * everyone.
 *
 * A JOB RECEIPT REVEALS NOTHING. `ReceiptEntry.revealed` is empty for a paid job. The receipt is
 * published on chain by `ReceiptPublished`, and the buyer paid for a result only they can read —
 * putting the plaintext in the receipt would undo the entire product in the name of auditability.
 * A competition is the opposite: entries were sealed to keep them secret UNTIL settlement, so
 * revealing them is what makes the ranking checkable.
 *
 * THE ENTRY SET IS THE JOIN SET. `SealedCompetition._recordEntries` reverts `EntryNotJoined` and
 * `DuplicateEntry`, and caps at `MAX_ENTRIES`. Producing a set that violates any of those does not
 * fail here — it fails as a reverted settlement after the TEE has already signed it.
 */

import { receiptHash, receiptBytes, scorerFor, type Receipt, type ReceiptEntry } from 'quadra-core';
import { competitionDomain, competitionTypes, jobDomain, jobTypes } from 'quadra-core';
import { settlementDigest, jobSettlementDigest } from 'quadra-core';
import { sign } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { MAX_ENTRIES, MAX_PROOFS, KIND_SCORING } from './chain/abis.js';
import type { FeedDataWithProof } from 'quadra-core';
import type { ResolvedPortfolio, ResolvedWindow } from './resolve.js';
import {
    computeMetric,
    parsePortfolioSubmission,
    PERF_BASE,
    type PortfolioSubmission,
} from './evaluators/portfolioRoi.js';
import { log } from './log.js';

/** One decrypted entrant, before scoring. */
export interface DecryptedEntry {
    readonly agent: Address;
    readonly ciphertextHash: Hex;
    readonly revealed: Record<string, string>;
}

export class OracleFaultError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OracleFaultError';
    }
}

export class UnknownEvaluatorError extends Error {
    constructor(readonly evaluatorId: string) {
        super(
            `this build has no scorer for "${evaluatorId}" — refusing to settle. A score it cannot ` +
                `produce is a score nobody can re-derive either, so the verifier would report the ` +
                `settlement as unknown rather than as correct.`,
        );
        this.name = 'UnknownEvaluatorError';
    }
}

function assertUsableWindow(window: ResolvedWindow, evaluatorId: string): void {
    if (window.startValue <= 0n) {
        throw new OracleFaultError(
            `the DA layer returned a non-positive start price (${window.startValue}) for ` +
                `"${evaluatorId}" — this is an oracle fault, not an agent fault, so nothing is scored`,
        );
    }
    if (window.end.value <= 0n) {
        throw new OracleFaultError(
            `the DA layer returned a non-positive end price (${window.end.value}) for ` +
                `"${evaluatorId}" — this is an oracle fault, not an agent fault, so nothing is scored`,
        );
    }
    if (window.lifetimeSecs <= 0) {
        throw new OracleFaultError(`scored window is not positive: ${window.lifetimeSecs}s`);
    }
}

/** Run the registered scorer. An agent fault becomes a zero carrying its reason. */
function scoreOne(
    evaluatorId: string,
    revealed: Record<string, string>,
    window: ResolvedWindow,
): { score: number; reason: string } {
    const scorer = scorerFor(evaluatorId);
    if (!scorer) throw new UnknownEvaluatorError(evaluatorId);

    const verdict = scorer({
        revealed,
        endPrice: window.end.value,
        startPrice: window.startValue,
        lifetimeSecs: window.lifetimeSecs,
    });

    if (verdict.ok) return { score: verdict.score, reason: '' };
    return { score: 0, reason: verdict.reason };
}

// --- paid jobs ------------------------------------------------------------------------------------

export interface JobResultInput {
    readonly jobId: Hex;
    readonly agent: Address;
    readonly evaluatorId: string;
    readonly ciphertextHash: Hex;
    readonly revealed: Record<string, string>;
    readonly window: ResolvedWindow;
    readonly teeImageDigest: string;
    /** Unix seconds this settlement was produced. Recorded in the receipt. */
    readonly resolvedAtSecs: number;
}

export interface UnsignedJobSettlement {
    readonly jobId: Hex;
    readonly agent: Address;
    /** uint8. `Passport.record` reverts above 100, so the scorer's clamp is load-bearing. */
    readonly score: number;
    readonly groundTruthValue: bigint;
    readonly receipt: Receipt;
    readonly receiptBytes: Hex;
    readonly receiptHash: Hex;
    readonly window: ResolvedWindow;
}

export function buildJobResult(input: JobResultInput): UnsignedJobSettlement {
    assertUsableWindow(input.window, input.evaluatorId);
    const { score } = scoreOne(input.evaluatorId, input.revealed, input.window);

    const entry: ReceiptEntry = {
        agent: input.agent,
        ciphertextHash: input.ciphertextHash,
        // Empty on purpose. See the header: this receipt is published on chain.
        revealed: {},
        score,
    };

    // `competitionId` doubles as the job id — one Receipt type covers both markets, and a job is
    // a one-entry competition as far as the audit trail is concerned.
    const receipt: Receipt = {
        competitionId: input.jobId,
        evaluatorId: input.evaluatorId,
        teeImageDigest: input.teeImageDigest,
        groundTruth: input.window.end.groundTruth,
        startValue: input.window.startValue.toString(),
        lifetimeSecs: input.window.lifetimeSecs,
        entries: [entry],
        resolvedAt: input.resolvedAtSecs,
    };

    return {
        jobId: input.jobId,
        agent: input.agent,
        score,
        groundTruthValue: input.window.end.value,
        receipt,
        receiptBytes: receiptBytes(receipt),
        receiptHash: receiptHash(receipt),
        window: input.window,
    };
}

// --- competitions ---------------------------------------------------------------------------------

export interface CompetitionResultInput {
    readonly competitionId: Hex;
    readonly evaluatorId: string;
    readonly kind: number;
    readonly entries: readonly DecryptedEntry[];
    readonly window: ResolvedWindow;
    readonly teeImageDigest: string;
    readonly resolvedAtSecs: number;
}

export interface SettlementEntry {
    readonly agent: Address;
    /** uint64. A PERFORMANCE metric is around 1e6; a SCORING score is in [0,100]. */
    readonly score: bigint;
}

export interface UnsignedCompetitionSettlement {
    readonly competitionId: Hex;
    /**
     * The signed ground truth, as PARALLEL ARRAYS index-aligned with `proofs`.
     *
     * Length 1 for a single-asset competition; one entry per attested leg for a portfolio. The
     * feed ids are signed alongside the values so `FtsoLib.checkGroundTruths` can refuse a proof
     * for an asset this settlement never named.
     */
    readonly feedIds: readonly Hex[];
    readonly groundTruthValues: readonly bigint[];
    readonly proofs: readonly FeedDataWithProof[];
    readonly entries: readonly SettlementEntry[];
    readonly receipt: Receipt;
    readonly receiptBytes: Hex;
    readonly receiptHash: Hex;
    /** The window the SCORER used — the primary asset's. See `ResolvedPortfolio.primary`. */
    readonly window: ResolvedWindow;
}

/**
 * The signed ground truth for a settlement measured against exactly one feed.
 *
 * Every non-portfolio settlement goes through here rather than building the three arrays inline,
 * so "one asset" is expressed once. The arrays must stay index-aligned and non-empty —
 * `FtsoLib.checkGroundTruths` reverts `NoGroundTruth` on an empty set rather than treating it as
 * nothing to check.
 */
function singleGroundTruth(window: ResolvedWindow): {
    feedIds: readonly Hex[];
    groundTruthValues: readonly bigint[];
    proofs: readonly FeedDataWithProof[];
} {
    return {
        feedIds: [window.end.feed.body.id],
        groundTruthValues: [window.end.value],
        proofs: [window.end.feed],
    };
}

export function buildCompetitionResult(
    input: CompetitionResultInput,
): UnsignedCompetitionSettlement {
    assertUsableWindow(input.window, input.evaluatorId);

    // Deduplicate before anything else. `getSubmissions` already keeps one row per agent, but the
    // contract reverts `DuplicateEntry` and a revert here costs a settlement, so the invariant is
    // enforced where it is cheap rather than assumed.
    const seen = new Set<string>();
    const unique: DecryptedEntry[] = [];
    for (const entry of input.entries) {
        const key = entry.agent.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(entry);
    }

    if (unique.length > MAX_ENTRIES) {
        throw new Error(
            `${unique.length} entrants exceeds SealedCompetition.MAX_ENTRIES (${MAX_ENTRIES}); ` +
                `the settlement would revert`,
        );
    }

    const receiptEntries: ReceiptEntry[] = [];
    const settlementEntries: SettlementEntry[] = [];

    for (const entry of unique) {
        const { score } = scoreOne(input.evaluatorId, entry.revealed, input.window);
        if (input.kind === KIND_SCORING && score > 100) {
            // Unreachable through the registered scorers, which clamp. Kept because the failure it
            // guards is expensive and silent-looking: `Passport.record` reverts above 100, so ONE
            // bad entry fails the WHOLE settlement, and the revert names Passport rather than the
            // entry that caused it.
            throw new Error(
                `entry for ${entry.agent} scored ${score}, above the 100 Passport accepts`,
            );
        }
        receiptEntries.push({
            agent: entry.agent,
            ciphertextHash: entry.ciphertextHash,
            // Revealed on purpose: a sealed competition is secret UNTIL settlement, and publishing
            // what each entrant actually submitted is what makes the ranking checkable by anyone.
            revealed: entry.revealed,
            score,
        });
        settlementEntries.push({ agent: entry.agent, score: BigInt(score) });
    }

    const receipt: Receipt = {
        competitionId: input.competitionId,
        evaluatorId: input.evaluatorId,
        teeImageDigest: input.teeImageDigest,
        groundTruth: input.window.end.groundTruth,
        startValue: input.window.startValue.toString(),
        lifetimeSecs: input.window.lifetimeSecs,
        entries: receiptEntries,
        resolvedAt: input.resolvedAtSecs,
    };

    return {
        competitionId: input.competitionId,
        ...singleGroundTruth(input.window),
        entries: settlementEntries,
        receipt,
        receiptBytes: receiptBytes(receipt),
        receiptHash: receiptHash(receipt),
        window: input.window,
    };
}

// --- portfolio competitions -----------------------------------------------------------------------

export interface PortfolioCompetitionInput {
    readonly competitionId: Hex;
    readonly evaluatorId: string;
    readonly entries: readonly DecryptedEntry[];
    readonly resolved: ResolvedPortfolio;
    readonly teeImageDigest: string;
    readonly resolvedAtSecs: number;
}

/**
 * A KIND_PERFORMANCE competition ranked on `PERF_BASE + roiBps`.
 *
 * Separate from `buildCompetitionResult` because nothing about it fits the same shape: the scorer
 * takes a price map rather than one price pair, the output is a uint64 metric rather than a
 * [0,100] score, and no Passport record is written (`SealedCompetition` only records for
 * KIND_SCORING, which is correct — a metric near 1e6 would corrupt the Bayesian `overall()`).
 *
 * An agent whose submission will not parse, or whose trades overdraw an allocation, scores the
 * ZERO-ROI baseline rather than 0. Zero would mean "lost everything", which is a different and
 * much harsher claim than "submitted nothing usable", and the receipt records the reason either
 * way.
 */
export function buildPortfolioCompetitionResult(
    input: PortfolioCompetitionInput,
): UnsignedCompetitionSettlement {
    const window = input.resolved.primary;
    assertUsableWindow(window, input.evaluatorId);

    const seen = new Set<string>();
    const receiptEntries: ReceiptEntry[] = [];
    const settlementEntries: SettlementEntry[] = [];

    for (const entry of input.entries) {
        const key = entry.agent.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const submission = parsePortfolioSubmission(entry.revealed);
        let metric = PERF_BASE;
        if ('ok' in submission && submission.ok === false) {
            log.warn('portfolio submission did not parse, scoring the flat baseline', {
                competitionId: input.competitionId,
                agent: entry.agent,
                reason: submission.reason,
            });
        } else {
            const verdict = computeMetric(
                submission as PortfolioSubmission,
                input.resolved.startPrices,
                input.resolved.endPrices,
            );
            if (verdict.ok) metric = verdict.metric;
            else {
                log.warn('portfolio could not be valued, scoring the flat baseline', {
                    competitionId: input.competitionId,
                    agent: entry.agent,
                    reason: verdict.reason,
                });
            }
        }

        receiptEntries.push({
            agent: entry.agent,
            ciphertextHash: entry.ciphertextHash,
            revealed: entry.revealed,
            // ~1e6, comfortably inside a JSON number. The settlement carries the bigint.
            score: Number(metric),
        });
        settlementEntries.push({ agent: entry.agent, score: metric });
    }

    if (settlementEntries.length > MAX_ENTRIES) {
        throw new Error(
            `${settlementEntries.length} entrants exceeds SealedCompetition.MAX_ENTRIES ` +
                `(${MAX_ENTRIES}); the settlement would revert`,
        );
    }

    // Every leg gets an on-chain proof, up to the contract's cap.
    //
    // OVER THE CAP THE TAIL IS DROPPED FROM THE PROOFS, NOT FROM THE SCORING. The prices are still
    // used to value the portfolio — refusing to settle would let one entrant naming a hundred
    // assets hold everyone else's payout hostage — so what degrades past MAX_PROOFS is how much of
    // the ground truth the CHAIN re-verifies, not whether the competition resolves. Sorted order
    // makes which assets those are deterministic and replayable rather than arrival-dependent.
    const covered = input.resolved.windows.slice(0, MAX_PROOFS);
    if (input.resolved.windows.length > MAX_PROOFS) {
        log.warn('more assets than the settlement can pin on chain; the tail is TEE-attested only', {
            competitionId: input.competitionId,
            assets: input.resolved.windows.length,
            maxProofs: MAX_PROOFS,
            // Joined rather than passed as an array: the log context is a flat scalar map, and
            // naming the assets is the whole value of the line.
            uncovered: input.resolved.windows
                .slice(MAX_PROOFS)
                .map((w) => w.asset)
                .join(','),
        });
    }

    const receipt: Receipt = {
        competitionId: input.competitionId,
        // The BARE evaluator id. This used to be `${id}@${primaryAsset}` so a reader could tell
        // which leg the single on-chain proof covered — but the verifier looks the evaluator up by
        // this exact string (`replayability(receipt.evaluatorId)`), and no scorer is registered
        // under "portfolio-roi@BTC". Every honest portfolio settlement therefore verified as
        // FAILED with "this build has no scorer ... or the settlement may not be genuine", which
        // is BUGS.md 4's failure mode arriving by a different route.
        //
        // The suffix is also now redundant: `groundTruths` below records every attested asset, and
        // `groundTruths[0]` IS the primary — the same leg `startValue` and `lifetimeSecs` describe.
        // A structured field a verifier can read beats an asset name encoded into a lookup key.
        evaluatorId: input.evaluatorId,
        teeImageDigest: input.teeImageDigest,
        groundTruth: window.end.groundTruth,
        groundTruths: covered.map((w) => ({
            asset: w.asset,
            groundTruth: w.window.end.groundTruth,
            startValue: w.window.startValue.toString(),
        })),
        startValue: window.startValue.toString(),
        lifetimeSecs: window.lifetimeSecs,
        entries: receiptEntries,
        resolvedAt: input.resolvedAtSecs,
    };

    return {
        competitionId: input.competitionId,
        feedIds: covered.map((w) => w.window.end.feed.body.id),
        groundTruthValues: covered.map((w) => w.window.end.value),
        proofs: covered.map((w) => w.window.end.feed),
        entries: settlementEntries,
        receipt,
        receiptBytes: receiptBytes(receipt),
        receiptHash: receiptHash(receipt),
        window,
    };
}

// --- signing (EIP-712 path only) -------------------------------------------------------------------

export interface SigningContext {
    readonly chainId: number;
    readonly jobEscrow: Address;
    readonly sealedCompetition: Address;
    readonly privateKey: Hex;
}

/**
 * Sign the digest quadra-core computes rather than re-declaring the typed data here.
 *
 * The domains and typehashes are frozen constants in `quadra-core/eip712.ts`, asserted against
 * their expected values at import time. Signing THAT digest is what guarantees the signature the
 * market recovers and the signature the verifier replays are over the same bytes — a second
 * hand-written copy of the struct in this file is exactly the drift the frozen constants exist to
 * prevent.
 */
export async function signJobSettlement(
    ctx: SigningContext,
    settlement: UnsignedJobSettlement,
): Promise<Hex> {
    const digest = jobSettlementDigest(ctx.chainId, ctx.jobEscrow, {
        jobId: settlement.jobId,
        receiptHash: settlement.receiptHash,
        agent: settlement.agent,
        score: settlement.score,
        groundTruthValue: settlement.groundTruthValue,
    });
    return sign({ hash: digest, privateKey: ctx.privateKey, to: 'hex' });
}

export async function signCompetitionSettlement(
    ctx: SigningContext,
    settlement: UnsignedCompetitionSettlement,
): Promise<Hex> {
    const digest = settlementDigest(ctx.chainId, ctx.sealedCompetition, {
        competitionId: settlement.competitionId,
        receiptHash: settlement.receiptHash,
        feedIds: settlement.feedIds,
        groundTruthValues: settlement.groundTruthValues,
        entries: settlement.entries,
    });
    return sign({ hash: digest, privateKey: ctx.privateKey, to: 'hex' });
}

/** Re-exported so a local test can assert the engine and the verifier agree on the typed data. */
export { competitionDomain, competitionTypes, jobDomain, jobTypes };
