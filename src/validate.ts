/**
 * validate.ts — the intake gate: did the agent deliver something well formed?
 *
 * This answers a DIFFERENT question from scoring, and keeping them apart is a product decision
 * rather than a tidiness one. Payment is released when the agent delivered a well-formed answer to
 * the job it was hired for. Whether that answer turns out to be ACCURATE is settled later and only
 * affects reputation. Conflate the two and an agent that did honest work on time goes unpaid
 * because the market moved — nobody would take jobs on those terms.
 *
 * So the checks here are structural: was there a delivery, can the enclave open it, does it carry
 * the fields the evaluator needs, in the shape the scorer will parse. Nothing reads market data.
 * The template lives in `quadra-core` and is therefore compiled into the measured image, which is
 * the reason it is not fetched: a template pulled at runtime would let an operator redefine "valid
 * delivery" AFTER the job was paid for.
 *
 * THIS FUNCTION NEVER THROWS. `releasePaymentFromTee` needs a signed verdict either way — an
 * invalid delivery is an answer, not an outage — so every failure that is genuinely about the
 * delivery becomes `valid: false` with a reason. Only an inability to reach the chain propagates,
 * because that is the enclave failing to answer rather than the agent failing to deliver.
 */

import { keccak256, type Hex } from 'viem';
import { validateAgainstTemplate, hasTemplate } from 'quadra-core';
import type { ChainReader } from './chain/reads.js';
import type { Decryptor } from './decrypt.js';

export interface ValidationVerdict {
    readonly jobId: Hex;
    readonly evaluatorId: string;
    /** Whether anything was delivered at all, separate from whether it was any good. */
    readonly delivered: boolean;
    readonly valid: boolean;
    readonly reason: string;
    /**
     * `keccak256(ciphertext)`, binding the verdict to the exact bytes judged.
     *
     * This is what stops a validate-then-replace race: `releasePaymentFromTee` reverts
     * `StaleDelivery` when this does not match `deliveredHash(jobId)`, so a verdict on one
     * delivery cannot pay out a different one.
     */
    readonly deliveryHash: Hex;
}

const NO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

function verdict(
    jobId: Hex,
    evaluatorId: string,
    delivered: boolean,
    valid: boolean,
    reason: string,
    deliveryHash: Hex = NO_HASH,
): ValidationVerdict {
    return { jobId, evaluatorId, delivered, valid, reason, deliveryHash };
}

export interface ValidateDeps {
    readonly chain: ChainReader;
    readonly decryptDelivery: Decryptor;
}

export async function validateDelivery(deps: ValidateDeps, jobId: Hex): Promise<ValidationVerdict> {
    const job = await deps.chain.getJob(jobId);

    // The guard ladder is ordered so the earliest, cheapest and most certain answer wins. Reading
    // the intake log before these would cost a chunked scan to tell a caller its id is wrong.
    if (job.user === '0x0000000000000000000000000000000000000000') {
        return verdict(jobId, '', false, false, 'no such job');
    }
    if (job.released) {
        return verdict(jobId, '', job.delivered, false, 'escrow already released');
    }
    if (!job.delivered) {
        return verdict(jobId, '', false, false, 'nothing delivered yet');
    }

    const intake = await deps.chain.getJobIntake(jobId);
    if (!intake) {
        // The job exists in storage but its JobPaid log is not in the scanned range. That is a
        // configuration fault (FROM_BLOCK too high), not an agent fault, and saying so keeps an
        // operator from reading it as a bad delivery.
        return verdict(jobId, '', true, false, 'the JobPaid log is not within FROM_BLOCK');
    }

    const onChainHash = await deps.chain.deliveredHashOf(jobId);
    const ciphertext = await deps.chain.getDeliveredCiphertext(jobId);
    if (!ciphertext) {
        return verdict(
            jobId,
            intake.evaluatorId,
            true,
            false,
            'the delivered ciphertext could not be recovered from its transaction',
            onChainHash,
        );
    }

    // Recompute rather than trusting the log: the verdict must be bound to bytes we actually read.
    const deliveryHash = keccak256(ciphertext);
    if (onChainHash !== NO_HASH && deliveryHash !== onChainHash) {
        return verdict(
            jobId,
            intake.evaluatorId,
            true,
            false,
            'the recovered ciphertext does not hash to the delivery recorded on chain',
            onChainHash,
        );
    }

    if (!hasTemplate(intake.evaluatorId)) {
        // An unknown evaluator is invalid rather than unscoreable, so the escrow refunds. Paying
        // for a deliverable this build cannot describe would be paying on the operator's word.
        return verdict(
            jobId,
            intake.evaluatorId,
            true,
            false,
            `this build has no intake template for "${intake.evaluatorId}"`,
            deliveryHash,
        );
    }

    const revealed = await deps.decryptDelivery(ciphertext);
    if (Object.keys(revealed).length === 0) {
        return verdict(
            jobId,
            intake.evaluatorId,
            true,
            false,
            'the delivery could not be decrypted',
            deliveryHash,
        );
    }

    const template = validateAgainstTemplate(intake.evaluatorId, revealed);
    return verdict(jobId, intake.evaluatorId, true, template.valid, template.reason, deliveryHash);
}
