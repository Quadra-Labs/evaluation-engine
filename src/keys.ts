/**
 * keys.ts — the TEE's identity on the EIP-712 path.
 *
 * ONE secp256k1 key does two jobs: agents ECIES-encrypt to its public half, and it signs the
 * EIP-712 settlement the markets recover against `TeeRegistry.activeTeeWallet()`. Using one key
 * for both is deliberate — a second key would need a second registry slot, a second rotation
 * procedure, and a second way for the two to fall out of step.
 *
 * The public key MUST be the 65-byte uncompressed form (`0x04 || X || Y`). `agent/app/src/seal.ts`
 * asserts exactly that before it spends anything, so a key in any other shape does not produce a
 * confusing error later — it stops every agent from delivering at all. viem's
 * `privateKeyToAccount().publicKey` is already uncompressed; `assertUncompressed` is here so that
 * stays true if the derivation ever changes.
 *
 * THIS FILE DOES NOT EXIST UNDER FCC. There the key belongs to Flare's TEE node, the engine holds
 * nothing, and decryption is an HTTP call to the node's sign port. Until the FCC path is the only
 * one, "no operator holds the key" is a claim about the deployment, not about the code — and
 * TEE_PRIVATE_KEY below is precisely the hole. It is a development convenience and it says so
 * loudly at boot.
 */

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import { log } from './log.js';

export interface TeeIdentity {
    /** Secret. Never logged, never returned by any route, never written to a receipt. */
    readonly privateKey: Hex;
    /** What `TeeRegistry.activeTeeWallet()` must hold for a settlement to be accepted. */
    readonly address: Hex;
    /** Uncompressed `0x04 || X || Y`, 65 bytes. What agents seal to. */
    readonly publicKey: Hex;
}

export function assertUncompressed(publicKey: string): void {
    const bytes = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
    if (bytes.length !== 130 || !bytes.startsWith('04')) {
        throw new Error(
            'TEE public key must be the 65-byte uncompressed form starting 0x04; ' +
                `got ${bytes.length / 2} bytes starting 0x${bytes.slice(0, 2)}`,
        );
    }
}

/**
 * Load the pinned key, or mint a fresh one.
 *
 * A fresh key on every boot is the SAFE default but it is operationally sharp: agents read the
 * public key from the chain, so until `setActiveTee` runs again nothing can seal to this instance.
 * That is why the log line below is at warn level even on the happy path.
 */
export function bootTeeIdentity(): TeeIdentity {
    const pinned = process.env['TEE_PRIVATE_KEY'];
    // `SIMULATE_ATTESTATION=false` is the production switch: it says this process expects to be
    // able to reach the Confidential Space launcher and produce a real attestation.
    const production = process.env['SIMULATE_ATTESTATION'] === 'false';

    if (pinned && production) {
        // REFUSING RATHER THAN WARNING, because the two states are not comparable. A warning is
        // right for a laptop, where nobody claimed the key was protected. In production the whole
        // product claim is that the key exists only inside the enclave and no operator can read
        // it — and a key that arrived through an environment variable was, by definition, read by
        // an operator on the way in. Booting anyway would produce a system that attests correctly,
        // settles correctly, and is lying about the one property it exists to provide.
        throw new Error(
            'TEE_PRIVATE_KEY is set while SIMULATE_ATTESTATION=false. In a real Confidential ' +
                'Space deployment the key is generated inside the enclave and never leaves it, so ' +
                'an externally supplied key would make the privacy claim false. Unset one of them.',
        );
    }

    if (pinned) {
        const key = (pinned.startsWith('0x') ? pinned : `0x${pinned}`) as Hex;
        if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
            throw new Error('TEE_PRIVATE_KEY is not a 32-byte hex key');
        }
        const account = privateKeyToAccount(key);
        assertUncompressed(account.publicKey);
        log.warn('using TEE_PRIVATE_KEY from the environment', {
            address: account.address,
            note: 'development only: a real TEE holds a key no operator can read',
        });
        return { privateKey: key, address: account.address, publicKey: account.publicKey };
    }

    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    assertUncompressed(account.publicKey);
    log.warn('generated a fresh TEE key at boot', {
        address: account.address,
        note: 'nothing can seal to this instance until TeeRegistry.setActiveTee names it',
    });
    return { privateKey: key, address: account.address, publicKey: account.publicKey };
}
