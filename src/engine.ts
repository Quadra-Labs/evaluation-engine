/**
 * engine.ts — the guard ladders, and the one place a settlement is produced.
 *
 * Both surfaces call into here: the EIP-712 HTTP service (`server.ts`) and the FCC extension
 * (`fcc/app/handlers.ts`). Having one implementation is what stops the two paths from disagreeing
 * about whether a job is ready, which entrants count, or what window it is scored over — a
 * disagreement that would surface as two different scores for the same job depending on which
 * relayer got there first.
 *
 * THE GUARDS ARE NOT DEFENSIVE PROGRAMMING. Each mirrors a `require` in the Solidity, and hitting
 * one on chain instead costs a reverted transaction and, for FCC, an instruction fee. Checking
 * here turns a burnt transaction into a `409` a relayer can back off on. They are ordered
 * cheapest-and-most-certain first: a storage read before a log scan, a terminal flag before a
 * clock comparison — the same order the contracts use, so the two cannot disagree about which
 * complaint a caller sees.
 */

import type { Hex } from 'viem';
import { notFound, terminal, tooEarly, upstream, EngineError } from './errors.js';
import { UnknownEvaluatorError, OracleFaultError } from './score.js';
import {
    buildCompetitionResult,
    buildJobResult,
    buildPortfolioCompetitionResult,
    signCompetitionSettlement,
    signJobSettlement,
    type DecryptedEntry,
    type SigningContext,
    type UnsignedCompetitionSettlement,
    type UnsignedJobSettlement,
} from './score.js';
import {
    resolveForCompetition,
    resolveForJob,
    resolveForPortfolio,
    type ResolvePolicy,
} from './resolve.js';
import {
    assertSettleable,
    assetsOf,
    evaluatorTier,
    parsePortfolioSubmission,
    scoreMarket,
    type PortfolioSubmission,
} from './evaluators/index.js';
import { decodeJobParams } from 'quadra-core';
import { validateDelivery, type ValidationVerdict } from './validate.js';
import type { ChainReader } from './chain/reads.js';
import type { Decryptors } from './decrypt.js';
import { log } from './log.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface EngineDeps {
    readonly chain: ChainReader;
    readonly decryptors: Decryptors;
    readonly policy: ResolvePolicy;
    readonly teeImageDigest: string;
    /** Absent on the FCC path, where Flare's node signs the ActionResult instead. */
    readonly signing?: SigningContext | undefined;
}

export interface SignedJobSettlement {
    readonly settlement: UnsignedJobSettlement;
    readonly signature: Hex;
}

export interface SignedCompetitionSettlement {
    readonly settlement: UnsignedCompetitionSettlement;
    readonly signature: Hex;
}

/** What a prediction-market evaluator can produce today: a score, and no way to settle it. */
export interface MarketScore {
    readonly jobId: Hex;
    readonly evaluatorId: string;
    readonly score: number;
    /** Always false. Kept as a field so a caller reads it rather than assuming. */
    readonly settleable: false;
    readonly reason: string;
}

export interface Engine {
    validateJob(jobId: Hex): Promise<ValidationVerdict>;
    scoreMarketJob(jobId: Hex): Promise<MarketScore>;
    buildJobSettlement(jobId: Hex): Promise<UnsignedJobSettlement>;
    scoreJob(jobId: Hex): Promise<SignedJobSettlement>;
    buildCompetitionSettlement(competitionId: Hex): Promise<UnsignedCompetitionSettlement>;
    settleCompetition(competitionId: Hex): Promise<SignedCompetitionSettlement>;
}

/**
 * Turn the two failures the scorer raises into the kinds a caller can act on. Everything else —
 * an RPC that refused, a DA layer that timed out — is upstream and worth retrying.
 */
function classify(err: unknown): EngineError {
    if (err instanceof EngineError) return err;
    if (err instanceof UnknownEvaluatorError) {
        return new EngineError('unsupported', err.message);
    }
    if (err instanceof OracleFaultError) {
        return new EngineError('upstream', err.message);
    }
    return upstream(err instanceof Error ? err.message : String(err));
}

function nowSecs(): number {
    return Math.floor(Date.now() / 1000);
}

export function makeEngine(deps: EngineDeps): Engine {
    function requireSigning(): SigningContext {
        if (!deps.signing) {
            throw new EngineError(
                'unsupported',
                'this instance holds no signing key: under FCC the node signs the result, so ask ' +
                    'the extension rather than the EIP-712 service',
            );
        }
        return deps.signing;
    }

    async function buildJob(jobId: Hex): Promise<UnsignedJobSettlement> {
        const job = await deps.chain.getJob(jobId);

        if (job.user === ZERO_ADDRESS) throw notFound(`no such job ${jobId}`);
        if (job.scored) throw terminal(`job ${jobId} is already scored`);
        if (!job.delivered) throw terminal(`job ${jobId} had nothing delivered`);
        // `scoreJobFromTee` requires the escrow to be released first: a job the buyer was refunded
        // for has no agent to credit, and one still in escrow has not been accepted yet.
        if (!job.released) throw tooEarly(`job ${jobId} has not had its escrow released yet`);

        const now = nowSecs();
        if (now < Number(job.lifetimeEnd)) {
            throw tooEarly(
                `job ${jobId} resolves at ${job.lifetimeEnd}, ${Number(job.lifetimeEnd) - now}s from now`,
            );
        }

        const intake = await deps.chain.getJobIntake(jobId);
        if (!intake) {
            throw notFound(
                `the JobPaid log for ${jobId} is not within FROM_BLOCK — lower it, or the job ` +
                    `predates this configuration`,
            );
        }

        const ciphertext = await deps.chain.getDeliveredCiphertext(jobId);
        // A delivery whose bytes cannot be recovered still settles, at zero. Refusing would strand
        // the agent's reputation on an unresolvable job forever, and the zero is honest: nothing
        // readable was delivered.
        const revealed = ciphertext ? await deps.decryptors.delivery(ciphertext) : {};
        const ciphertextHash = await deps.chain.deliveredHashOf(jobId);

        if (Object.keys(revealed).length === 0) {
            log.warn('scoring a job whose delivery could not be read', { jobId });
        }

        // Refuse BEFORE the DA-layer calls. An evaluator that cannot settle should not cost two
        // rate-limited round trips to find that out, and the refusal names the real blocker.
        assertSettleable(intake.evaluatorId, true);

        const window = await resolveForJob(deps.policy, {
            evaluatorId: intake.evaluatorId,
            params: intake.params,
            paidAtSecs: intake.paidAtSecs,
            lifetimeEndSecs: Number(job.lifetimeEnd),
        });

        return buildJobResult({
            jobId,
            agent: job.agent,
            evaluatorId: intake.evaluatorId,
            ciphertextHash,
            revealed,
            window,
            teeImageDigest: deps.teeImageDigest,
            resolvedAtSecs: now,
        });
    }

    async function buildCompetition(competitionId: Hex): Promise<UnsignedCompetitionSettlement> {
        const competition = await deps.chain.getCompetition(competitionId);

        // `exists`, never `resolveAt != 0`. The contract replaced that sentinel precisely because
        // it let a funded competition read as nonexistent, and reading a nonexistent one as a free
        // open competition is the mirror image of the same bug.
        if (!competition.exists) throw notFound(`no such competition ${competitionId}`);
        if (competition.settled) throw terminal(`competition ${competitionId} is already settled`);
        if (competition.cancelled) throw terminal(`competition ${competitionId} was cancelled`);

        const now = nowSecs();
        if (now < Number(competition.resolveAt)) {
            throw tooEarly(
                `competition ${competitionId} resolves at ${competition.resolveAt}, ` +
                    `${Number(competition.resolveAt) - now}s from now`,
            );
        }

        // The scan floor is the competition's OWN creation block. Taking it from the caller would
        // let a requester name a later block and hide submissions it did not want scored — the
        // settlement would still verify, still be TEE-signed, and simply omit an entrant who paid
        // to be there.
        const createdAt = await deps.chain.getCompetitionCreatedBlock(competitionId);
        if (createdAt === undefined) {
            throw notFound(
                `the CompetitionCreated log for ${competitionId} is not within FROM_BLOCK`,
            );
        }

        const submissions = await deps.chain.getSubmissions(competitionId, createdAt);
        if (submissions.length === 0) {
            throw tooEarly(`competition ${competitionId} has no submissions to settle`);
        }

        const entries: DecryptedEntry[] = [];
        for (const submission of submissions) {
            // `_recordEntries` reverts `EntryNotJoined`, so an address that submitted without
            // joining takes the whole settlement down with it. Dropping it here is the difference
            // between one ignored entry and no settlement at all.
            const joined = await deps.chain.hasJoined(competitionId, submission.agent);
            if (!joined) {
                log.warn('dropping a submission from an address that never joined', {
                    competitionId,
                    agent: submission.agent,
                });
                continue;
            }
            entries.push({
                agent: submission.agent,
                ciphertextHash: submission.ciphertextHash,
                revealed: await deps.decryptors.submission(submission.ciphertext),
            });
        }

        if (entries.length === 0) {
            throw tooEarly(`competition ${competitionId} has no joined entrants to settle`);
        }

        assertSettleable(competition.evaluatorId, false);

        // A PERFORMANCE competition takes a different route entirely: a price pair per asset
        // rather than one, a uint64 metric rather than a [0,100] score, and no Passport record.
        if (evaluatorTier(competition.evaluatorId).tier === 'portfolio') {
            const assets = new Set<string>();
            for (const entry of entries) {
                const submission = parsePortfolioSubmission(entry.revealed);
                if ('ok' in submission && submission.ok === false) continue;
                for (const asset of assetsOf(submission as PortfolioSubmission)) assets.add(asset);
            }
            if (assets.size === 0) {
                throw tooEarly(
                    `competition ${competitionId} has no readable portfolio to value yet`,
                );
            }
            const resolved = await resolveForPortfolio(deps.policy, {
                evaluatorId: competition.evaluatorId,
                assets: [...assets],
                resolveAtSecs: Number(competition.resolveAt),
            });
            return buildPortfolioCompetitionResult({
                competitionId,
                evaluatorId: competition.evaluatorId,
                entries,
                resolved,
                teeImageDigest: deps.teeImageDigest,
                resolvedAtSecs: now,
            });
        }

        const window = await resolveForCompetition(deps.policy, {
            evaluatorId: competition.evaluatorId,
            resolveAtSecs: Number(competition.resolveAt),
        });

        return buildCompetitionResult({
            competitionId,
            evaluatorId: competition.evaluatorId,
            kind: competition.kind,
            entries,
            window,
            teeImageDigest: deps.teeImageDigest,
            resolvedAtSecs: now,
        });
    }

    return {
        async validateJob(jobId) {
            try {
                return await validateDelivery(
                    { chain: deps.chain, decryptDelivery: deps.decryptors.delivery },
                    jobId,
                );
            } catch (err) {
                throw classify(err);
            }
        },

        /**
         * Score a prediction-market job WITHOUT settling it.
         *
         * This exists so the three polymarket evaluators are live code rather than a stub waiting
         * on a contract change: the whole path runs — read the chain, decrypt, fetch Gamma or the
         * CLOB, score — and stops exactly where it must, at the settlement no FTSO proof can
         * support. When an FDC Web2Json verification path lands in `contracts`, the missing half
         * is the proof, not the scoring.
         */
        async scoreMarketJob(jobId) {
            try {
                const intake = await deps.chain.getJobIntake(jobId);
                if (!intake) throw notFound(`no JobPaid log for ${jobId} within FROM_BLOCK`);
                if (evaluatorTier(intake.evaluatorId).tier !== 'market') {
                    throw new EngineError(
                        'unsupported',
                        `"${intake.evaluatorId}" is not a prediction-market evaluator; use /score-job`,
                    );
                }

                const ciphertext = await deps.chain.getDeliveredCiphertext(jobId);
                if (!ciphertext) throw terminal(`job ${jobId} has no recoverable delivery`);
                const revealed = await deps.decryptors.delivery(ciphertext);

                const score = await scoreMarket({
                    evaluatorId: intake.evaluatorId,
                    revealed,
                    params: decodeJobParams(intake.params) as Record<string, string>,
                    nowSecs: nowSecs(),
                });

                return {
                    jobId,
                    evaluatorId: intake.evaluatorId,
                    score,
                    settleable: false,
                    reason:
                        'no FTSO anchor feed covers a prediction-market outcome, and every ' +
                        'settlement path requires a proof matching the signed groundTruthValue',
                } as const;
            } catch (err) {
                throw classify(err);
            }
        },

        async buildJobSettlement(jobId) {
            try {
                return await buildJob(jobId);
            } catch (err) {
                throw classify(err);
            }
        },

        async scoreJob(jobId) {
            const signing = requireSigning();
            try {
                const settlement = await buildJob(jobId);
                return { settlement, signature: await signJobSettlement(signing, settlement) };
            } catch (err) {
                throw classify(err);
            }
        },

        async buildCompetitionSettlement(competitionId) {
            try {
                return await buildCompetition(competitionId);
            } catch (err) {
                throw classify(err);
            }
        },

        async settleCompetition(competitionId) {
            const signing = requireSigning();
            try {
                const settlement = await buildCompetition(competitionId);
                return {
                    settlement,
                    signature: await signCompetitionSettlement(signing, settlement),
                };
            } catch (err) {
                throw classify(err);
            }
        },
    };
}
