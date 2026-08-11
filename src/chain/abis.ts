/**
 * abis.ts — the contract surface the TEE workload touches.
 *
 * Human-readable signatures rather than the JSON artifacts, matching `data/src/chain/abis.ts` and
 * `agent/app/src/chain/abis.ts` so all three can be compared by eye. This is the fourth
 * hand-written copy in the system and it inherits that exposure: `contracts/script/abi.sh --check`
 * proves `contracts/abi/*.json` still matches the Solidity, but nothing proves these fragments
 * match the artifacts. A drift here fails at runtime with an opaque decode error.
 *
 * The engine is almost entirely a READER. The only write it ever makes is binding its own key into
 * TeeRegistry on the dev path; settlements are handed to a caller to submit, because this workload
 * must not need gas, a nonce, or a funded wallet to do its job.
 *
 * Two fragments below carry the deltas most likely to be copied wrong from the Flare reference:
 * `competitions` returns THIRTEEN fields with an explicit `exists` flag (the reference decodes
 * eight and uses `resolveAt != 0` as an existence sentinel, which reads a nonexistent competition
 * as a free open one), and `deliver`/`submitSealed` are listed as writes we never call purely so
 * `decodeFunctionData` can recover the ciphertext from their calldata.
 */

import { parseAbi } from 'viem';

export const jobEscrowAbi = parseAbi([
    // --- reads ---
    'function jobs(bytes32) view returns (address user, address agent, bytes32 category, uint256 escrow, uint64 deliveryDeadline, uint64 lifetimeEnd, bool delivered, bool released, bool scored)',
    'function deliveredHash(bytes32) view returns (bytes32)',
    'function scoredReceiptHash(bytes32) view returns (bytes32)',

    // --- calldata decoding only. The engine never sends either of these. ---
    // `Delivered` carries the ciphertext HASH, not the bytes. The bytes exist only in the
    // transaction that carried them, so recovering a submission means decoding this call.
    'function deliver(bytes32 jobId, bytes ciphertext)',

    // --- events ---
    // Nine fields and all three indexed slots. `params` and `userPubKey` are why the engine can
    // work out which feed a job is about without trusting whoever asked it to score.
    'event JobPaid(bytes32 indexed jobId, address indexed user, address indexed agent, string evaluatorId, uint256 cost, uint64 deliveryDeadline, uint64 lifetimeEnd, bytes userPubKey, bytes params)',
    'event Delivered(bytes32 indexed jobId, address indexed agent, bytes32 ciphertextHash)',
]);

export const sealedCompetitionAbi = parseAbi([
    // --- reads ---
    // THIRTEEN fields. Existence is `exists`, never `resolveAt != 0`: the contract replaced that
    // sentinel precisely because it let a funded competition read as nonexistent.
    'function competitions(bytes32) view returns (string evaluatorId, bytes32 category, uint8 kind, uint256 stake, uint256 seedPrize, uint256 stakedTotal, uint256 prizePool, uint64 resolveAt, uint64 threshold, bool exists, bool settled, bool cancelled, address creator)',
    'function submissions(bytes32, address) view returns (bytes32)',
    'function joined(bytes32, address) view returns (bool)',
    'function settledReceiptHash(bytes32) view returns (bytes32)',

    // --- calldata decoding only ---
    'function submitSealed(bytes32 competitionId, bytes ciphertext)',

    // --- events ---
    'event CompetitionCreated(bytes32 indexed competitionId, string evaluatorId, uint8 kind, uint256 stake, uint256 seedPrize, uint64 resolveAt, uint64 threshold, address indexed creator)',
    'event Joined(bytes32 indexed competitionId, address indexed agent, uint256 stake)',
    'event Submitted(bytes32 indexed competitionId, address indexed agent, bytes32 ciphertextHash)',
]);

export const teeRegistryAbi = parseAbi([
    'function activeTeeWallet() view returns (address)',
    // A public `bytes` state variable, so the generated getter takes NO arguments.
    'function activeTeePublicKey() view returns (bytes)',
    'function expectedImageDigest() view returns (string)',
    'function vtpm() view returns (address)',
    'function owner() view returns (address)',

    // --- the attested binding: the real one ---
    // PERMISSIONLESS. The security is the token, not the sender, so any funded key may relay it —
    // which matters because the enclave itself holds no gas and must never need any. The three
    // byte strings are the base64url-DECODED JWT parts.
    'function register(bytes header, bytes payload, bytes signature, address teeWallet, bytes teePublicKey)',

    // --- the dev binding ---
    // onlyOwner. It sets the wallet, the public key and the image digest in a single transaction,
    // which is what makes binding the TEE and pinning its image one atomic act rather than two.
    'function setActiveTee(address teeWallet, bytes teePublicKey, string imageDigest)',
    'function setExpectedImageDigest(string imageDigest)',

    'event TeeRegistered(address indexed teeWallet, string imageDigest)',
]);

/// `ConfidentialSpaceVerifier`, for the JWKS sync tool. Nothing else in the engine touches it.
export const vtpmVerifierAbi = parseAbi([
    'function setKey(bytes kid, bytes exponent, bytes modulus)',
    'function removeKey(bytes kid)',
    'function hasKey(bytes kid) view returns (bool)',
    'function requiredSubPrefix() view returns (string)',
    'function setRequiredSubPrefix(string prefix)',
    'function owner() view returns (address)',
]);

/** `SealedCompetition.KIND_SCORING` — ranked on a [0,100] score, and the only kind Passport records. */
export const KIND_SCORING = 0;
/** `SealedCompetition.KIND_PERFORMANCE` — ranked on `PERF_BASE + roi_bps`, a uint64 around 1e6. */
export const KIND_PERFORMANCE = 1;
/** `SealedCompetition.PERF_BASE`. A flat portfolio scores exactly this. */
export const PERF_BASE = 1_000_000n;
/** `SealedCompetition.MAX_ENTRIES`. A settlement naming more than this reverts. */
export const MAX_ENTRIES = 512;
