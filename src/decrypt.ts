/**
 * decrypt.ts — the seam between "who holds the key" and "what the payload looks like".
 *
 * Two axes, four combinations, one interface. The payload axis is fixed by what the agent sent:
 *
 *   COMPETITION submission — a BARE geth-ECIES blob whose plaintext is the JSON submission itself.
 *   PAID-JOB delivery      — a dual-reader ENVELOPE: hex of the UTF-8 JSON of
 *                            `{v, iv, ct, tag, encKUser, encKTee}`, where the payload is under
 *                            AES-256-GCM and the key K is wrapped twice.
 *
 * The custody axis is the migration: on the EIP-712 path the engine holds a private key and
 * unwraps in process; under FCC it holds nothing and the unwrap is an HTTP call to Flare's TEE
 * node on the sign port. Both produce the same `Decryptor`, so nothing downstream knows or cares
 * which one is running. That is the point of the seam — the custody change is a wiring change in
 * `main.ts`, not a rewrite of the scorer.
 *
 * TWO RULES THAT ARE NOT PREFERENCES.
 *
 * 1. THE ENCLAVE READS `encKTee` ONLY. `openEnvelope` (the buyer's path, `encKUser`) must never be
 *    called here. The two wraps use DIFFERENT libraries on purpose — `encKTee` is geth-ECIES
 *    because that is what Flare's node decrypts, `encKUser` is eciesjs because the buyer opens it
 *    in a wallet — and consolidating them produces a blob nobody can open, failing late, after the
 *    escrow is funded.
 * 2. A FAILED UNWRAP IS NOT AN EXCEPTION. An envelope that is not addressed to us, or a blob a
 *    hostile agent made up, is a question with the answer "no". `nodeUnwrap` returns `undefined`
 *    and the scorer turns an unopenable submission into a zero. Throwing would let one bad entry
 *    take down a whole competition's settlement.
 */

import { openEnvelopeAsTee, openEnvelopeWithTeeKey, openTeeKey, type Unwrap } from 'quadra-core';
import type { Hex } from 'viem';
import type { NodeClient } from './fcc/base/node.js';
import { log, errorMessage } from './log.js';

/**
 * Ciphertext in, the agent's submitted fields out. Always async: FCC's unwrap is a round trip.
 *
 * `undefined` means COULD NOT OPEN; `{}` means opened and there was nothing inside. Collapsing both
 * to `{}` is what BUGS.md 29 is about — from the outside they score identically, and from an
 * operator's chair they could not be more different. An unopenable payload is very often OUR fault
 * (the enclave restarted and the on-chain public key is stale, BUGS.md 36), and it arrives as a
 * flood affecting every agent at once; an empty one is a single agent sending junk. A monitor that
 * cannot separate them cannot see the outage.
 */
export type Decryptor = (ciphertext: Hex) => Promise<Record<string, string> | undefined>;

/**
 * Why a payload could not be scored, as a stable string rather than prose.
 *
 * These are LOG FIELDS and a relayer's classification input, so they are values a machine can group
 * by. Each has a different owner:
 *
 *   `unrecoverable-tx`       the bytes never came back from the transaction. The delivery reached
 *                            the contract through something other than a direct call — a multicall,
 *                            a relayer contract, an account-abstraction bundle — and only
 *                            `keccak256(ciphertext)` is on chain. THE AGENT'S WALLET CHOICE.
 *   `undecryptable-payload`  the bytes came back and would not open. Either a hostile blob, or the
 *                            enclave's key rotated after the agent sealed to it. OURS, usually.
 *   `empty-delivery`         it opened, and the agent had put nothing in it. THE AGENT'S.
 */
export type PayloadFault = 'unrecoverable-tx' | 'undecryptable-payload' | 'empty-delivery';

/**
 * Classify a recovery attempt, from the two signals every call site already holds.
 *
 * One implementation so the job path, the competition path and `/validate` cannot drift into
 * describing the same failure three different ways — which is the state BUGS.md 29 found them in.
 * Returns `undefined` when there is nothing wrong.
 */
export function payloadFault(
    ciphertext: Hex | undefined,
    revealed: Record<string, string> | undefined,
): PayloadFault | undefined {
    if (ciphertext === undefined) return 'unrecoverable-tx';
    if (revealed === undefined) return 'undecryptable-payload';
    if (Object.keys(revealed).length === 0) return 'empty-delivery';
    return undefined;
}

function toBytes(ciphertext: Hex): Uint8Array {
    const hex = ciphertext.startsWith('0x') ? ciphertext.slice(2) : ciphertext;
    return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function asFields(plaintext: Uint8Array): Record<string, string> {
    const parsed: unknown = JSON.parse(Buffer.from(plaintext).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        // Submissions are flat string maps by contract; anything else is stringified rather than
        // dropped so a template failure names the real field instead of "missing".
        out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
}

// --- local key: the EIP-712 path -----------------------------------------------------------------

/** A bare geth-ECIES blob, opened with a key this process holds. Competition submissions. */
export function makeDecryptor(privateKey: Hex): Decryptor {
    return async (ciphertext) => {
        try {
            return asFields(await openTeeKey(privateKey, ciphertext));
        } catch (err) {
            log.debug('could not open a sealed submission', { reason: errorMessage(err) });
            return undefined;
        }
    };
}

/** A dual-reader envelope, opened through its `encKTee` wrap. Paid-job deliveries. */
export function makeEnvelopeDecryptor(privateKey: Hex): Decryptor {
    return async (ciphertext) => {
        try {
            return await openEnvelopeWithTeeKey(privateKey, ciphertext);
        } catch (err) {
            log.debug('could not open a delivered envelope', { reason: errorMessage(err) });
            return undefined;
        }
    };
}

// --- node custody: the FCC path ------------------------------------------------------------------

/**
 * Route an unwrap through Flare's TEE node.
 *
 * Returns `undefined` rather than throwing, which is what `openEnvelopeAsTee` expects: it asks the
 * unwrap a question and reads a negative answer as "not ours", not as a failure.
 */
export function nodeUnwrap(node: NodeClient): Unwrap {
    return async (wrapped: Hex) => {
        try {
            return await node.decrypt(toBytes(wrapped));
        } catch (err) {
            log.debug('the TEE node declined to decrypt', { reason: errorMessage(err) });
            return undefined;
        }
    };
}

/** A bare geth-ECIES blob, opened by the node. Competition submissions under FCC. */
export function makeNodeDecryptor(node: NodeClient): Decryptor {
    const unwrap = nodeUnwrap(node);
    return async (ciphertext) => {
        const plaintext = await unwrap(ciphertext);
        if (!plaintext) return undefined;
        try {
            return asFields(plaintext);
        } catch {
            // Opened, but the plaintext was not JSON. Still `undefined`: the bytes we hold are not
            // a submission, which is a different statement from "the agent submitted nothing".
            return undefined;
        }
    };
}

/** A dual-reader envelope, whose `encKTee` wrap is opened by the node. Deliveries under FCC. */
export function makeNodeEnvelopeDecryptor(node: NodeClient): Decryptor {
    const unwrap = nodeUnwrap(node);
    return async (ciphertext) => {
        try {
            return await openEnvelopeAsTee(unwrap, ciphertext);
        } catch (err) {
            log.debug('could not open a delivered envelope through the node', {
                reason: errorMessage(err),
            });
            return undefined;
        }
    };
}

/** Both decryptors a handler needs: deliveries are envelopes, competition entries are not. */
export interface Decryptors {
    readonly submission: Decryptor;
    readonly delivery: Decryptor;
}

export function localDecryptors(privateKey: Hex): Decryptors {
    return { submission: makeDecryptor(privateKey), delivery: makeEnvelopeDecryptor(privateKey) };
}

export function nodeDecryptors(node: NodeClient): Decryptors {
    return { submission: makeNodeDecryptor(node), delivery: makeNodeEnvelopeDecryptor(node) };
}
