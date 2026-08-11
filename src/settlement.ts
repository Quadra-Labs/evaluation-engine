/**
 * settlement.ts — the contract argument tuples, assembled and made safe to put on the wire.
 *
 * The engine does not submit transactions. It holds no gas, no nonce and no funded wallet, and
 * that is a property worth keeping rather than a stage it has not reached: a workload that cannot
 * transact cannot be pressured into transacting. What it produces instead is everything a caller
 * needs to submit, plus a signature over the whole of it.
 *
 * That signature is what makes the caller untrusted. It covers the score, the ground-truth value,
 * the entry list and the receipt hash together, so a relayer can choose WHEN a settlement lands
 * and nothing about what it says. Change one entry and the recovery fails; drop the receipt and
 * `BadReceipt` fires; substitute a different FTSO proof and `GroundTruthMismatch` fires.
 *
 * ARGUMENT ORDER IS THE ABI. These tuples are positional. viem will happily encode a
 * correctly-typed tuple in the wrong order, and the resulting transaction reverts with no reason
 * string, so the order below is copied from the Solidity and should be re-read against it rather
 * than remembered.
 */

import type { Address, Hex } from 'viem';
import type { FeedDataWithProof } from 'quadra-core';
import type {
    UnsignedCompetitionSettlement,
    UnsignedJobSettlement,
    SettlementEntry,
} from './score.js';

/**
 * `JobEscrow.scoreJob(bytes32,bytes32,uint8,uint256,bytes,FeedDataWithProof,bytes)`.
 */
export type JobSettleArgs = readonly [
    jobId: Hex,
    receiptHash: Hex,
    score: number,
    groundTruthValue: bigint,
    signature: Hex,
    proof: FeedDataWithProof,
    receipt: Hex,
];

/**
 * `SealedCompetition.settle(bytes32,bytes32,bytes21[],uint256[],EntryInput[],bytes,
 * FeedDataWithProof[],bytes)`.
 *
 * `EntryInput.score` is uint64, so it crosses as a bigint. The Flare reference declares it uint8;
 * copying that misaligns every field after it while still "encoding successfully".
 *
 * `feedIds`, `groundTruthValues` and `proofs` are three separate positional arguments that must
 * stay index-aligned. They are NOT adjacent in the tuple — `entries` and `signature` sit between
 * the values and the proofs, matching the Solidity — which is exactly the kind of ordering this
 * file's header warns is easy to get wrong from memory.
 */
export type CompetitionSettleArgs = readonly [
    competitionId: Hex,
    receiptHash: Hex,
    feedIds: readonly Hex[],
    groundTruthValues: readonly bigint[],
    entries: readonly SettlementEntry[],
    signature: Hex,
    proofs: readonly FeedDataWithProof[],
    receipt: Hex,
];

export function jobSettleArgs(settlement: UnsignedJobSettlement, signature: Hex): JobSettleArgs {
    return [
        settlement.jobId,
        settlement.receiptHash,
        settlement.score,
        settlement.groundTruthValue,
        signature,
        settlement.window.end.feed,
        settlement.receiptBytes,
    ];
}

export function competitionSettleArgs(
    settlement: UnsignedCompetitionSettlement,
    signature: Hex,
): CompetitionSettleArgs {
    return [
        settlement.competitionId,
        settlement.receiptHash,
        settlement.feedIds,
        settlement.groundTruthValues,
        settlement.entries,
        signature,
        settlement.proofs,
        settlement.receiptBytes,
    ];
}

// --- the wire shape -------------------------------------------------------------------------------
//
// Every integer leaves as a DECIMAL STRING. JSON numbers are IEEE doubles, and a groundTruthValue
// in 1e-8 units passes 2^53 at a price of about $90 million — not a concern for BTC today, and
// exactly the kind of limit that is discovered by a settlement being silently off by one wei.
// Strings have no such edge, and every consumer here already parses with BigInt.

export interface WireFeedProof {
    readonly proof: readonly Hex[];
    readonly body: {
        readonly votingRoundId: number;
        readonly id: Hex;
        readonly value: number;
        readonly turnoutBPS: number;
        readonly decimals: number;
    };
}

export interface WireJobSettlement {
    readonly jobId: Hex;
    readonly agent: Address;
    readonly score: number;
    readonly groundTruthValue: string;
    readonly receiptHash: Hex;
    readonly receipt: Hex;
    readonly proof: WireFeedProof;
    readonly signature: Hex;
}

export interface WireCompetitionSettlement {
    readonly competitionId: Hex;
    /** Index-aligned with `groundTruthValues` and `proofs`. Length 1 unless it is a portfolio. */
    readonly feedIds: readonly Hex[];
    readonly groundTruthValues: readonly string[];
    readonly entries: readonly { readonly agent: Address; readonly score: string }[];
    readonly receiptHash: Hex;
    readonly receipt: Hex;
    readonly proofs: readonly WireFeedProof[];
    readonly signature: Hex;
}

function wireProof(feed: FeedDataWithProof): WireFeedProof {
    return {
        proof: feed.proof,
        body: {
            votingRoundId: feed.body.votingRoundId,
            id: feed.body.id,
            value: feed.body.value,
            turnoutBPS: feed.body.turnoutBPS,
            decimals: feed.body.decimals,
        },
    };
}

export function wireJobSettlement(
    settlement: UnsignedJobSettlement,
    signature: Hex,
): WireJobSettlement {
    return {
        jobId: settlement.jobId,
        agent: settlement.agent,
        score: settlement.score,
        groundTruthValue: settlement.groundTruthValue.toString(),
        receiptHash: settlement.receiptHash,
        receipt: settlement.receiptBytes,
        proof: wireProof(settlement.window.end.feed),
        signature,
    };
}

export function wireCompetitionSettlement(
    settlement: UnsignedCompetitionSettlement,
    signature: Hex,
): WireCompetitionSettlement {
    return {
        competitionId: settlement.competitionId,
        feedIds: settlement.feedIds,
        groundTruthValues: settlement.groundTruthValues.map((v) => v.toString()),
        entries: settlement.entries.map((e) => ({ agent: e.agent, score: e.score.toString() })),
        receiptHash: settlement.receiptHash,
        receipt: settlement.receiptBytes,
        proofs: settlement.proofs.map(wireProof),
        signature,
    };
}
