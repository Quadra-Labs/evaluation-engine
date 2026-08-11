/**
 * reads.ts — everything the enclave learns about a job or a competition, learned from the chain.
 *
 * This module is the reason the workload can be trusted. On Sui the caller decrypted the agent's
 * result and POSTed a finished job envelope, so whoever asked for a score also chose the inputs it
 * was scored against. Here nothing is taken from the request except a `bytes32` id: the evaluator,
 * the asset, the window, the entrant set and the ciphertext are all read from Coston2. A relayer
 * can decide WHEN a settlement happens and nothing about WHAT it says.
 *
 * Two consequences shape the code.
 *
 * THE CIPHERTEXT IS NOT IN AN EVENT. `Delivered` and `Submitted` carry only `keccak256(ciphertext)`
 * — storing the bytes would cost the caller for storage nobody reads on chain. So recovering a
 * submission means finding the transaction that carried it and decoding its calldata. That is why
 * `deliver` and `submitSealed` appear in the ABI at all.
 *
 * LOG SCANS ARE EXPENSIVE HERE. The public Coston2 RPC caps `eth_getLogs` at 30 blocks per request
 * and blocks land every ~1.7 seconds, so a day is about 1,700 requests. Every scan below goes
 * through quadra-core's `getLogsChunked`, newest-first with `stopAtFirstHit` wherever one hit is
 * the answer, and every scan is floored: for a competition by its own `CompetitionCreated` block,
 * never by anything the caller supplied.
 */

import {
    createPublicClient,
    decodeFunctionData,
    defineChain,
    http,
    type Abi,
    type Address,
    type Hex,
    type PublicClient,
} from 'viem';
import { getLogsChunked } from 'quadra-core';
import { jobEscrowAbi, sealedCompetitionAbi } from './abis.js';

export const coston2 = defineChain({
    id: 114,
    name: 'Flare Testnet Coston2',
    nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
    rpcUrls: { default: { http: ['https://coston2-api.flare.network/ext/C/rpc'] } },
    blockExplorers: {
        default: { name: 'Coston2 Explorer', url: 'https://coston2-explorer.flare.network' },
    },
});

export interface ReaderConfig {
    readonly chainId: number;
    readonly rpcUrl: string;
    readonly jobEscrow: Address;
    readonly sealedCompetition: Address;
    readonly fromBlock: bigint;
}

export interface Job {
    readonly user: Address;
    readonly agent: Address;
    readonly category: Hex;
    readonly escrow: bigint;
    readonly deliveryDeadline: bigint;
    readonly lifetimeEnd: bigint;
    readonly delivered: boolean;
    readonly released: boolean;
    readonly scored: boolean;
}

/** The half of a job that lives in the `JobPaid` log rather than in storage. */
export interface JobIntake {
    readonly evaluatorId: string;
    readonly params: Hex;
    readonly userPubKey: Hex;
    /** The block timestamp of `JobPaid`. With `lifetimeEnd` this is the scoring window. */
    readonly paidAtSecs: number;
}

export interface Competition {
    readonly evaluatorId: string;
    readonly category: Hex;
    readonly kind: number;
    readonly stake: bigint;
    readonly seedPrize: bigint;
    readonly stakedTotal: bigint;
    readonly prizePool: bigint;
    readonly resolveAt: bigint;
    readonly threshold: bigint;
    /** The existence flag. Read THIS, never `resolveAt != 0`. */
    readonly exists: boolean;
    readonly settled: boolean;
    readonly cancelled: boolean;
    readonly creator: Address;
}

export interface Submission {
    readonly agent: Address;
    /**
     * The sealed bytes, or `undefined` when they could not be recovered from the transaction.
     *
     * Absent is NOT the same as absent from the competition. `Submitted(competitionId, agent, hash)`
     * is on chain either way, so an entrant whose bytes we cannot read demonstrably did submit —
     * dropping them here without a word (which is what this did before BUGS.md 29) leaves an
     * auditor holding an on-chain event with no matching entry and no explanation. What to do about
     * it is the ENGINE's decision, so this reports and does not decide.
     */
    readonly ciphertext: Hex | undefined;
    readonly ciphertextHash: Hex;
    /** The transaction the bytes were meant to come from, so a warning can name it. */
    readonly txHash: Hex;
}

export interface ChainReader {
    readonly client: PublicClient;
    getJob(jobId: Hex): Promise<Job>;
    getJobIntake(jobId: Hex): Promise<JobIntake | undefined>;
    /** `keccak256(ciphertext)` as the contract recorded it, for cross-checking what we recovered. */
    deliveredHashOf(jobId: Hex): Promise<Hex>;
    getDeliveredCiphertext(jobId: Hex): Promise<Hex | undefined>;
    getCompetition(competitionId: Hex): Promise<Competition>;
    getCompetitionCreatedBlock(competitionId: Hex): Promise<bigint | undefined>;
    getSubmissions(competitionId: Hex, fromBlock: bigint): Promise<Submission[]>;
    hasJoined(competitionId: Hex, agent: Address): Promise<boolean>;
}

export function makeChainReader(config: ReaderConfig): ChainReader {
    const chain = config.chainId === coston2.id ? coston2 : undefined;
    const client = createPublicClient({
        ...(chain ? { chain } : {}),
        transport: http(config.rpcUrl),
    }) as PublicClient;

    /**
     * The bytes an agent actually sent, recovered from the calldata of the transaction that
     * carried them. `argIndex` is 1 for both `deliver(bytes32,bytes)` and
     * `submitSealed(bytes32,bytes)`.
     */
    async function ciphertextFromTx(txHash: Hex, abi: Abi): Promise<Hex | undefined> {
        const tx = await client.getTransaction({ hash: txHash });
        try {
            const decoded = decodeFunctionData({ abi, data: tx.input });
            const arg = (decoded.args as readonly unknown[] | undefined)?.[1];
            return typeof arg === 'string' ? (arg as Hex) : undefined;
        } catch {
            // The delivery reached the contract through something other than a direct call — a
            // multicall, a relayer contract, an account abstraction bundle. The hash on chain is
            // still authoritative; we simply cannot recover the bytes this way.
            return undefined;
        }
    }

    async function latestBlock(): Promise<bigint> {
        return client.getBlockNumber();
    }

    return {
        client,

        async getJob(jobId) {
            const row = (await client.readContract({
                address: config.jobEscrow,
                abi: jobEscrowAbi,
                functionName: 'jobs',
                args: [jobId],
            })) as readonly [
                Address,
                Address,
                Hex,
                bigint,
                bigint,
                bigint,
                boolean,
                boolean,
                boolean,
            ];
            return {
                user: row[0],
                agent: row[1],
                category: row[2],
                escrow: row[3],
                deliveryDeadline: row[4],
                lifetimeEnd: row[5],
                delivered: row[6],
                released: row[7],
                scored: row[8],
            };
        },

        async getJobIntake(jobId) {
            const toBlock = await latestBlock();
            const found = await getLogsChunked({
                client,
                fromBlock: config.fromBlock,
                toBlock,
                stopAtFirstHit: true,
                fetch: (from, to) =>
                    client.getContractEvents({
                        address: config.jobEscrow,
                        abi: jobEscrowAbi,
                        eventName: 'JobPaid',
                        args: { jobId },
                        fromBlock: from,
                        toBlock: to,
                    }),
            });

            const paid = found[0];
            if (!paid) return undefined;

            const block = await client.getBlock({ blockNumber: paid.blockNumber });
            return {
                evaluatorId: paid.args.evaluatorId ?? '',
                params: (paid.args.params ?? '0x') as Hex,
                userPubKey: (paid.args.userPubKey ?? '0x') as Hex,
                paidAtSecs: Number(block.timestamp),
            };
        },

        async deliveredHashOf(jobId) {
            return (await client.readContract({
                address: config.jobEscrow,
                abi: jobEscrowAbi,
                functionName: 'deliveredHash',
                args: [jobId],
            })) as Hex;
        },

        async getDeliveredCiphertext(jobId) {
            const toBlock = await latestBlock();
            const found = await getLogsChunked({
                client,
                fromBlock: config.fromBlock,
                toBlock,
                stopAtFirstHit: true,
                fetch: (from, to) =>
                    client.getContractEvents({
                        address: config.jobEscrow,
                        abi: jobEscrowAbi,
                        eventName: 'Delivered',
                        args: { jobId },
                        fromBlock: from,
                        toBlock: to,
                    }),
            });

            // `getLogsChunked` returns oldest-first. A job can only be delivered once
            // (`JobEscrow.deliver` reverts on a second call), so the last is also the only.
            const delivered = found[found.length - 1];
            if (!delivered) return undefined;
            return ciphertextFromTx(delivered.transactionHash, jobEscrowAbi as Abi);
        },

        async getCompetition(competitionId) {
            const row = (await client.readContract({
                address: config.sealedCompetition,
                abi: sealedCompetitionAbi,
                functionName: 'competitions',
                args: [competitionId],
            })) as readonly [
                string,
                Hex,
                number,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                boolean,
                boolean,
                boolean,
                Address,
            ];
            return {
                evaluatorId: row[0],
                category: row[1],
                kind: row[2],
                stake: row[3],
                seedPrize: row[4],
                stakedTotal: row[5],
                prizePool: row[6],
                resolveAt: row[7],
                threshold: row[8],
                exists: row[9],
                settled: row[10],
                cancelled: row[11],
                creator: row[12],
            };
        },

        async getCompetitionCreatedBlock(competitionId) {
            const toBlock = await latestBlock();
            const found = await getLogsChunked({
                client,
                fromBlock: config.fromBlock,
                toBlock,
                stopAtFirstHit: true,
                fetch: (from, to) =>
                    client.getContractEvents({
                        address: config.sealedCompetition,
                        abi: sealedCompetitionAbi,
                        eventName: 'CompetitionCreated',
                        args: { competitionId },
                        fromBlock: from,
                        toBlock: to,
                    }),
            });
            return found[0]?.blockNumber;
        },

        /**
         * Every entrant's LATEST sealed submission.
         *
         * `fromBlock` must be the competition's own creation block. Letting a caller name a later
         * floor would let it hide submissions it does not want scored — the settlement would still
         * verify, still be signed by a real TEE, and simply omit an entrant who paid to be there.
         */
        async getSubmissions(competitionId, fromBlock) {
            const toBlock = await latestBlock();
            const logs = await getLogsChunked({
                client,
                fromBlock,
                toBlock,
                fetch: (from, to) =>
                    client.getContractEvents({
                        address: config.sealedCompetition,
                        abi: sealedCompetitionAbi,
                        eventName: 'Submitted',
                        args: { competitionId },
                        fromBlock: from,
                        toBlock: to,
                    }),
            });

            // Oldest-first, so a later resubmission overwrites an earlier one. `submitSealed`
            // permits resubmission until `resolveAt`; the last one is what the agent stands behind.
            const latest = new Map<Address, { hash: Hex; txHash: Hex }>();
            for (const entry of logs) {
                const agent = entry.args.agent;
                const hash = entry.args.ciphertextHash;
                if (!agent || !hash) continue;
                latest.set(agent, { hash: hash as Hex, txHash: entry.transactionHash });
            }

            const out: Submission[] = [];
            for (const [agent, { hash, txHash }] of latest) {
                const ciphertext = await ciphertextFromTx(txHash, sealedCompetitionAbi as Abi);
                out.push({ agent, ciphertext, ciphertextHash: hash, txHash });
            }
            return out;
        },

        async hasJoined(competitionId, agent) {
            return (await client.readContract({
                address: config.sealedCompetition,
                abi: sealedCompetitionAbi,
                functionName: 'joined',
                args: [competitionId, agent],
            })) as boolean;
        },
    };
}
