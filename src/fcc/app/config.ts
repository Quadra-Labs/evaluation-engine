/**
 * config.ts — the three verbs, as the bytes32 pairs the chain dispatches on.
 *
 * THESE STRINGS ARE A CROSS-REPO CONTRACT. `EvaluationInstructionSender.sol` declares the same
 * four constants as `bytes32("...")`, and the comparison happens on the full 32 padded bytes.
 * A mismatch — a different case, a stray space, a renamed verb — is accepted on chain and then
 * SILENTLY never delivered to this extension. There is no revert, no event, no log: the
 * instruction simply never arrives, which looks exactly like a slow voting round.
 *
 * THE NAMES ALSO HAD TO AVOID A RESERVED-WORD COLLISION. Flare reserves the `F_` prefix for system
 * op types and reserves seventeen COMMAND names outright: TEE_ATTESTATION, TEE_INFO, TEE_BACKUP,
 * KEY_GENERATE, KEY_INFO, KEY_PROOF, KEY_DELETE, KEY_DIRECT_BACKUP, KEY_DIRECT_RESTORE,
 * KEY_DATA_PROVIDER_RESTORE, INITIALIZE_POLICY, UPDATE_POLICY, SET_MACHINE_PATH_LIST, PAY,
 * REISSUE, VRF, PROVE. A custom op type whose COMMAND reuses one of those passes local validation
 * and is never delivered — the same silent failure, from a different cause. VALIDATE, SCORE_JOB
 * and SETTLE_COMP collide with none of them and none start with `F_`. Anyone adding a fourth verb
 * must check that list first; naming one PAY or PROVE would break it invisibly.
 */

import { stringToBytes32Hex } from '../base/encoding.js';

/** Bump when the on-chain interface or the handler behaviour changes: Flare's registration path
 * treats the code version as part of the extension lifecycle. */
export const VERSION = '1.0.0';

export const OP_TYPE_EVALUATION = 'EVALUATION';
export const OP_COMMAND_VALIDATE = 'VALIDATE';
export const OP_COMMAND_SCORE_JOB = 'SCORE_JOB';
export const OP_COMMAND_SETTLE_COMP = 'SETTLE_COMP';

/** The padded forms actually compared. Derived once so no call site pads by hand. */
export const OP_TYPE_EVALUATION_B32 = stringToBytes32Hex(OP_TYPE_EVALUATION);
export const OP_COMMAND_VALIDATE_B32 = stringToBytes32Hex(OP_COMMAND_VALIDATE);
export const OP_COMMAND_SCORE_JOB_B32 = stringToBytes32Hex(OP_COMMAND_SCORE_JOB);
export const OP_COMMAND_SETTLE_COMP_B32 = stringToBytes32Hex(OP_COMMAND_SETTLE_COMP);

/**
 * Where the extension listens, and where Flare's TEE node serves `/decrypt`.
 *
 * Read from the environment rather than assumed. Flare publishes TWO different defaults for the
 * sign port — 7701 in the sign-extension guide, 9090 in the scaffold's own `config.go` — and the
 * compose stack injects the real one.
 */
export const EXTENSION_PORT = process.env['EXTENSION_PORT'] ?? '7702';
export const SIGN_PORT = process.env['SIGN_PORT'] ?? '7701';
