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
    hasAnchorFeed,
    makePriceCache,
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
import { decodeJobParams, jobAsset } from 'quadra-core';
import { validateDelivery, type ValidationVerdict } from './validate.js';
import type { ChainReader } from './chain/reads.js';
import { payloadFault, type Decryptors } from './decrypt.js';
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
    // One memo for the life of the process. Every key names a finalized voting round, so the
    // cached reading is immutable history rather than something that can go stale — what it buys
    // is that a relayer retrying a settlement does not pay for the DA-layer round trips that
    // already answered. See `makePriceCache`.
    const priceCache = makePriceCache();

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
        const revealed = ciphertext ? await deps.decryptors.delivery(ciphertext) : undefined;
        const ciphertextHash = await deps.chain.deliveredHashOf(jobId);

        // A JOB WITH AN UNREADABLE DELIVERY SETTLES AT ZERO. A COMPETITION ENTRY IS DROPPED. The
        // asymmetry is deliberate and it is not about how bad the failure is — it is about what
        // each market owes the agent at the end.
        //
        // A paid job must reach a terminal state with a Passport word written, because that is what
        // the escrow's other exit does: `refundNotDelivered` records a mandatory zero. Leaving the
        // job unscored would strand the agent's reputation on it forever and hold the buyer's
        // escrow with it, so refusing is not the kinder option — it is the one with no ending. The
        // zero is honest: nothing readable was delivered.
        //
        // A competition entry has no such debt. `SealedCompetition` writes the Passport only for
        // KIND_SCORING and only for entries the settlement names, so an omitted entrant carries no
        // record at all — which is the right outcome for a submission nobody can read, and strictly
        // better than a permanent zero for an agent whose only mistake may have been their wallet.
        // What they do lose is the stake, which is why the drop is now LOUD (see below).
        const fault = payloadFault(ciphertext, revealed);
        if (fault) {
            log.warn('scoring a job whose delivery could not be read', {
                jobId,
                // A stable field, not prose: `unrecoverable-tx` is the agent's wallet, and
                // `undecryptable-payload` arriving for every job at once is an operator's
                // emergency (a restarted enclave, BUGS.md 36) rather than an agent problem.
                fault,
                score: 0,
            });
        }

        // Refuse BEFORE the DA-layer calls. An evaluator that cannot settle should not cost two
        // rate-limited round trips to find that out, and the refusal names the real blocker.
        assertSettleable(intake.evaluatorId, true);

        const window = await resolveForJob(deps.policy, {
            evaluatorId: intake.evaluatorId,
            params: intake.params,
            paidAtSecs: intake.paidAtSecs,
            lifetimeEndSecs: Number(job.lifetimeEnd),
            cache: priceCache,
        });

        return buildJobResult({
            jobId,
            agent: job.agent,
            evaluatorId: intake.evaluatorId,
            ciphertextHash,
            revealed: revealed ?? {},
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
            // TERMINAL, not too-early — the same reasoning as the empty-asset-union case below.
            // `submitSealed` reverts `NotOpen` from `resolveAt` onwards and the clock guard above
            // has already passed, so the entry set is FINAL: no later attempt will see a submission
            // that is not here now. A keeper told "too early" retries this forever against a
            // competition that can never gain an entrant, and the real remedy — `cancel` after
            // CANCEL_WINDOW, then each agent withdraws its stake — needs a person, not a retry.
            throw terminal(
                `competition ${competitionId} has no submissions and submissions closed at ` +
                    `resolveAt, so it can never gain one — cancel it to release the seed prize`,
            );
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

            // Bytes we could not recover are dropped rather than scored — see the asymmetry note in
            // `buildJob` — but never silently. `Submitted` is on chain, so this entrant provably
            // took part and provably paid a stake; an auditor comparing the log to the settlement
            // is owed a reason, and `unrecoverable-tx` names the cause precisely enough to answer
            // the agent who asks why they were not ranked.
            const revealed = submission.ciphertext
                ? await deps.decryptors.submission(submission.ciphertext)
                : undefined;
            if (submission.ciphertext === undefined) {
                log.warn('dropping a submission whose bytes could not be recovered', {
                    competitionId,
                    agent: submission.agent,
                    txHash: submission.txHash,
                    fault: 'unrecoverable-tx',
                    note: 'submitSealed must be a DIRECT call: only its hash is stored on chain',
                });
                continue;
            }
            // An UNOPENABLE entry is a different case and is kept: it is scored, at zero or at the
            // portfolio baseline, exactly as any other unusable submission. Dropping it would let a
            // stale enclave key quietly empty a competition instead of settling one everybody lost.
            const fault = payloadFault(submission.ciphertext, revealed);
            if (fault) {
                log.warn('an entry could not be read; it is scored, not dropped', {
                    competitionId,
                    agent: submission.agent,
                    fault,
                });
            }
            entries.push({
                agent: submission.agent,
                ciphertextHash: submission.ciphertextHash,
                revealed: revealed ?? {},
            });
        }

        if (entries.length === 0) {
            // Also terminal. Everything that emptied this list is fixed history: who joined, who
            // submitted, and which transactions the bytes could be recovered from. Retrying re-runs
            // the same reads over the same closed set.
            throw terminal(
                `competition ${competitionId} has ${submissions.length} submission(s) but no ` +
                    `settleable entrant: every one either never joined or had bytes that could not ` +
                    `be recovered. Submissions closed at resolveAt, so this cannot change — cancel ` +
                    `the competition to release the stakes`,
            );
        }

        assertSettleable(competition.evaluatorId, false);

        // A PERFORMANCE competition takes a different route entirely: a price pair per asset
        // rather than one, a uint64 metric rather than a [0,100] score, and no Passport record.
        if (evaluatorTier(competition.evaluatorId).tier === 'portfolio') {
            // AN UNPRICEABLE ASSET IS THE ENTRANT'S FAULT, NOT THE COMPETITION'S.
            //
            // The asset union used to be built across every entrant and handed straight to
            // `resolveForPortfolio`, which throws on anything with no FTSO anchor feed. So one
            // address sealing a portfolio that named DOGE made the WHOLE settlement throw — an
            // `upstream` error a relayer retries forever, on a competition that can never resolve,
            // with every other entrant's stake and the seeded prize locked behind it until the
            // cancel window opens three days later. Sealing it costs the attacker one stake.
            //
            // Rejecting per ENTRANT instead is the same rule this engine already applies to a
            // submission that will not decrypt or will not parse: the settlement proceeds and the
            // author of the bad entry carries the consequence alone. Their assets stay out of the
            // union entirely — they cannot be valued anyway — so a hostile entrant cannot even make
            // everyone else pay for extra DA-layer round trips.
            const assets = new Set<string>();
            let unparseable = 0;
            let unpriceable = 0;
            for (const entry of entries) {
                const submission = parsePortfolioSubmission(entry.revealed);
                if ('ok' in submission && submission.ok === false) {
                    unparseable++;
                    continue;
                }
                const named = assetsOf(submission as PortfolioSubmission);
                const unknown = named.filter((asset) => !hasAnchorFeed(asset));
                if (unknown.length > 0) {
                    unpriceable++;
                    log.warn('excluding an entrant that named an asset with no FTSO anchor feed', {
                        competitionId,
                        agent: entry.agent,
                        assets: unknown.join(','),
                        note: 'it scores the flat baseline; the settlement proceeds without it',
                    });
                    continue;
                }
                for (const asset of named) assets.add(asset);
            }
            if (assets.size === 0) {
                // TERMINAL, not too-early. `submitSealed` reverts `NotOpen` once `resolveAt` has
                // passed and this branch is only reached after it has, so the entry set is final:
                // no later attempt sees anything different. Retrying is the one thing that cannot
                // help, and the remedy — `cancel` after CANCEL_WINDOW, then each agent withdraws
                // its own stake — needs someone to be told rather than a keeper to keep trying.
                throw terminal(
                    `competition ${competitionId} has no valuable portfolio: ${unparseable} of ` +
                        `${entries.length} entrants did not parse and ${unpriceable} named an asset ` +
                        `with no FTSO anchor feed. Submissions closed at resolveAt, so this cannot ` +
                        `change — cancel the competition to release the stakes.`,
                );
            }
            const resolved = await resolveForPortfolio(deps.policy, {
                evaluatorId: competition.evaluatorId,
                // The ASSETS are each entrant's, from their own sealed portfolio; the WINDOW is the
                // competition's. A portfolio competition declares no single asset, so `params` is
                // not consulted here — only `lifetimeSecs` is.
                assets: [...assets],
                resolveAtSecs: Number(competition.resolveAt),
                windowSecs: competition.lifetimeSecs,
                cache: priceCache,
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
            // The competition's OWN scope and window, not this engine's configuration. Both are
            // fixed on chain when it is created, so an operator can no longer change what a
            // competition is measured against — or over how long — without changing the code hash.
            asset: jobAsset(competition.params),
            windowSecs: competition.lifetimeSecs,
            cache: priceCache,
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
                if (!ciphertext) {
                    throw terminal(
                        `job ${jobId} has no recoverable delivery (unrecoverable-tx): only its ` +
                            `hash is on chain and deliver() was not called directly`,
                    );
                }
                const revealed = await deps.decryptors.delivery(ciphertext);
                // This endpoint SCORES and never settles, so it may refuse rather than zero — a
                // caller asking for a market score gets an answer or an error, not a silent 0 it
                // cannot tell apart from a genuinely wrong forecast.
                if (revealed === undefined) {
                    throw terminal(`job ${jobId} has a delivery that will not open`);
                }

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
