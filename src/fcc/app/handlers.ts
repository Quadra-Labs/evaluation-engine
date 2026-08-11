/**
 * handlers.ts — the three FCC verbs, wired to the same engine the EIP-712 service uses.
 *
 * Each handler is the same three steps: decode a `bytes32` subject id out of the instruction, ask
 * the engine, abi-encode the answer. Everything interesting — the guard ladders, the decryption,
 * the scoring, the receipt — lives in `engine.ts` and is shared, so the FCC path and the EIP-712
 * path cannot produce different scores for the same job.
 *
 * WHAT IS DIFFERENT HERE IS WHO SIGNS. Nothing below signs anything. The handler returns
 * abi-encoded bytes and Flare's TEE node signs the whole `ActionResult` around them, which is what
 * `TeeActionResult.recoverSigner` checks on chain. That is why these handlers hold no key and why
 * the engine is constructed without a `signing` context on this path.
 *
 * STATUS 1 DOES NOT MEAN "THE ANSWER WAS YES". A validation that rejects a delivery is a
 * SUCCESSFUL answer carrying `valid: false`, and it must be status 1 — `releasePaymentFromTee`
 * needs a signed verdict either way, and a status 0 produces no usable signature, so a rejected
 * delivery would strand the escrow with nothing able to refund or release it. Status 0 is reserved
 * for "the enclave could not answer at all".
 *
 * WHAT IS NOT HERE: a relayer. Requesting instructions and relaying results back on chain belongs
 * to `scheduler`, deliberately. Flare's reference keeps its keeper inside this package, next to
 * the enclave code, which blurs exactly the boundary the design is judged on: the thing that
 * chooses WHEN to settle should not live inside the thing that decides WHAT the settlement says.
 */

import {
    encodeTeeCompetitionSettlement,
    encodeTeeJobScore,
    encodeTeeValidation,
} from 'quadra-core/fcc';
import { decodeAbiParameters, type Hex } from 'viem';
import {
    OP_COMMAND_SCORE_JOB_B32,
    OP_COMMAND_SETTLE_COMP_B32,
    OP_COMMAND_VALIDATE_B32,
    OP_TYPE_EVALUATION_B32,
} from './config.js';
import {
    STATUS_ERROR,
    STATUS_SUCCESS,
    type HandlerFunc,
    type HandlerResult,
    type RegisterFunc,
} from '../base/types.js';
import { encodeFailure, EngineError } from '../../errors.js';
import { errorMessage, log } from '../../log.js';
import type { Engine } from '../../engine.js';

/** Every Quadra instruction message is a bare `abi.encode(bytes32 subjectId)`. */
export function decodeSubjectId(originalMessage: Hex): Hex {
    const [id] = decodeAbiParameters([{ type: 'bytes32' }], originalMessage);
    return id as Hex;
}

// --- reported state -------------------------------------------------------------------------------
//
// `GET /state` is the only window an operator has into a running extension, and it must not become
// a side channel: counters only, never an id, never a score, never a decrypted field.

interface Counters {
    validated: number;
    rejected: number;
    jobsScored: number;
    competitionsSettled: number;
    failed: number;
}

let counters: Counters = {
    validated: 0,
    rejected: 0,
    jobsScored: 0,
    competitionsSettled: 0,
    failed: 0,
};

export function resetState(): void {
    counters = { validated: 0, rejected: 0, jobsScored: 0, competitionsSettled: 0, failed: 0 };
}

export function reportState(): unknown {
    return { ...counters };
}

// --- handlers -------------------------------------------------------------------------------------

export interface HandlerDeps {
    readonly engine: Engine;
}

/**
 * Turn a failure into a status-0 result.
 *
 * `too-early` is worth distinguishing in the LOG but not in the status: FCC has no "ask me again"
 * code that a relayer reads, so an instruction that arrives before a job resolves is answered with
 * an error the relayer retries by sending a new instruction.
 */
function failure(verb: string, err: unknown): HandlerResult {
    counters.failed += 1;
    if (err instanceof EngineError) {
        const level = err.kind === 'too-early' ? 'debug' : 'warn';
        log[level](`${verb} refused`, { kind: err.kind });
        // `kind: message`, and the prefix is a contract — see `encodeFailure`. A relayer reads
        // the kind from the head of this string; it must never match on the prose after it.
        return [null, STATUS_ERROR, encodeFailure(err)];
    }
    log.error(`${verb} failed`, { reason: errorMessage(err) });
    return [null, STATUS_ERROR, errorMessage(err)];
}

export function makeValidateHandler(deps: HandlerDeps): HandlerFunc {
    return async (originalMessage) => {
        try {
            const jobId = decodeSubjectId(originalMessage as Hex);
            const verdict = await deps.engine.validateJob(jobId);
            if (verdict.valid) counters.validated += 1;
            else counters.rejected += 1;

            // Status 1 for BOTH outcomes. See the header.
            return [
                encodeTeeValidation({
                    jobId: verdict.jobId,
                    deliveryHash: verdict.deliveryHash,
                    valid: verdict.valid,
                    reason: verdict.reason,
                }),
                STATUS_SUCCESS,
                null,
            ];
        } catch (err) {
            return failure('validate', err);
        }
    };
}

export function makeScoreJobHandler(deps: HandlerDeps): HandlerFunc {
    return async (originalMessage) => {
        try {
            const jobId = decodeSubjectId(originalMessage as Hex);
            const settlement = await deps.engine.buildJobSettlement(jobId);
            counters.jobsScored += 1;
            return [
                encodeTeeJobScore({
                    jobId: settlement.jobId,
                    receiptHash: settlement.receiptHash,
                    score: settlement.score,
                    groundTruthValue: settlement.groundTruthValue,
                    receipt: settlement.receiptBytes,
                    proof: settlement.window.end.feed,
                }),
                STATUS_SUCCESS,
                null,
            ];
        } catch (err) {
            return failure('score-job', err);
        }
    };
}

export function makeSettleCompetitionHandler(deps: HandlerDeps): HandlerFunc {
    return async (originalMessage) => {
        try {
            const competitionId = decodeSubjectId(originalMessage as Hex);
            const settlement = await deps.engine.buildCompetitionSettlement(competitionId);
            counters.competitionsSettled += 1;
            return [
                encodeTeeCompetitionSettlement({
                    competitionId: settlement.competitionId,
                    receiptHash: settlement.receiptHash,
                    // The parallel arrays come off the settlement as a set. Rebuilding any of them
                    // here from `window.end.feed` — which the single-proof version did — would
                    // silently drop every asset but the primary on the FCC path only, so the two
                    // settlement routes would attest to different things.
                    feedIds: settlement.feedIds,
                    groundTruthValues: settlement.groundTruthValues,
                    entries: settlement.entries,
                    receipt: settlement.receiptBytes,
                    proofs: settlement.proofs,
                }),
                STATUS_SUCCESS,
                null,
            ];
        } catch (err) {
            return failure('settle-competition', err);
        }
    };
}

/** Three exact pairs, no wildcard: an unimplemented verb should answer 501, not be absorbed. */
export function makeRegister(deps: HandlerDeps): RegisterFunc {
    return (framework) => {
        framework.handle(
            OP_TYPE_EVALUATION_B32,
            OP_COMMAND_VALIDATE_B32,
            makeValidateHandler(deps),
        );
        framework.handle(
            OP_TYPE_EVALUATION_B32,
            OP_COMMAND_SCORE_JOB_B32,
            makeScoreJobHandler(deps),
        );
        framework.handle(
            OP_TYPE_EVALUATION_B32,
            OP_COMMAND_SETTLE_COMP_B32,
            makeSettleCompetitionHandler(deps),
        );
    };
}
