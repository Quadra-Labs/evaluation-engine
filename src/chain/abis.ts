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
 * `competitions` returns FIFTEEN fields with an explicit `exists` flag (the reference decodes
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
    // FIFTEEN fields. Existence is `exists`, never `resolveAt != 0`: the contract replaced that
    // sentinel precisely because it let a funded competition read as nonexistent.
    //
    // `lifetimeSecs` and `params` are APPENDED, after `creator` and after the omitted `splitPct`,
    // so every index that already existed still points at the same field. That is deliberate on the
    // Solidity side and it is why this line could be widened rather than re-ordered — a shifted
    // index decodes cleanly into the wrong field, which nothing here would catch.
    //
    // `params` is the competition's own scope (JSON-in-hex, the same blob a paid job carries) and
    // `lifetimeSecs` is the window it is scored over. Before they existed the engine substituted
    // `DEFAULT_FEED` and `DEFAULT_LIFETIME_SECS` from its own config, so an ETH competition was
    // graded against the BTC feed and nobody could read the window they were judged over.
    'function competitions(bytes32) view returns (string evaluatorId, bytes32 category, uint8 kind, uint256 stake, uint256 seedPrize, uint256 stakedTotal, uint256 prizePool, uint64 resolveAt, uint64 threshold, bool exists, bool settled, bool cancelled, address creator, uint32 lifetimeSecs, bytes params)',
    'function submissions(bytes32, address) view returns (bytes32)',
    'function joined(bytes32, address) view returns (bool)',
    'function settledReceiptHash(bytes32) view returns (bytes32)',

    // --- calldata decoding only ---
    'function submitSealed(bytes32 competitionId, bytes ciphertext)',

    // --- events ---
    'event CompetitionCreated(bytes32 indexed competitionId, string evaluatorId, uint8 kind, uint256 stake, uint256 seedPrize, uint64 resolveAt, uint64 threshold, address indexed creator, uint32 lifetimeSecs, bytes params)',
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

/**
 * `SealedCompetition.settle` — declared but NEVER CALLED. The engine holds no wallet.
 *
 * It is here so `settle`'s positional layout is covered by `test/abis.mjs` like everything else.
 * `settlement.ts::CompetitionSettleArgs` builds this tuple by hand, and it was the one positional
 * layout in the four repos held correct by reading alone: a future reordering of the Solidity
 * parameters would regenerate `contracts/abi/`, pass `abi.sh --check`, pass both ABI checkers, and
 * still silently break the tuple — surfacing as a reasonless revert in whatever finally submits it.
 *
 * Note `proofs` is NOT adjacent to `groundTruthValues`: `entries` and `signature` sit between them.
 * That is the detail a hand-built tuple gets wrong.
 */
export const sealedCompetitionSettleAbi = parseAbi([
    'struct FeedData { uint32 votingRoundId; bytes21 id; int32 value; uint16 turnoutBPS; int8 decimals; }',
    'struct FeedDataWithProof { bytes32[] proof; FeedData body; }',
    'struct EntryInput { address agent; uint64 score; }',
    'function settle(bytes32 competitionId, bytes32 receiptHash, bytes21[] feedIds, uint256[] groundTruthValues, EntryInput[] entries, bytes signature, FeedDataWithProof[] proofs, bytes receipt)',
]);

/** `SealedCompetition.KIND_SCORING` — ranked on a [0,100] score, and the only kind Passport records. */
export const KIND_SCORING = 0;
/** `SealedCompetition.KIND_PERFORMANCE` — ranked on `PERF_BASE + roi_bps`, a uint64 around 1e6. */
export const KIND_PERFORMANCE = 1;
/** `SealedCompetition.PERF_BASE`. A flat portfolio scores exactly this. */
export const PERF_BASE = 1_000_000n;
/** `SealedCompetition.MAX_ENTRIES`. A settlement naming more than this reverts. */
export const MAX_ENTRIES = 512;
/**
 * `SealedCompetition.MAX_PROOFS`. The most (feedId, value, proof) triples one settlement may carry.
 *
 * A portfolio whose entrants collectively name more assets than this still SETTLES: the first
 * MAX_PROOFS assets in sorted order carry on-chain proofs and the tail is attested by the TEE
 * signature alone. Truncating rather than refusing is deliberate — refusing would let one entrant
 * naming a hundred assets block everyone else's payout.
 */
export const MAX_PROOFS = 10;
