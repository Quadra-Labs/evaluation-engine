/**
 * selfRegister.ts — bind this enclave's key on chain by PROVING it is an enclave.
 *
 * This is the attested counterpart to `registerTee.ts`, and the difference between them is the
 * whole point of the deployment:
 *
 *   `register-tee`   the owner asserts "this key belongs to a TEE". The chain takes their word.
 *   `self-register`  the chain verifies a Google-signed Confidential Space token, checks the
 *                    attested container image digest against the one it has pinned, and binds the
 *                    key ONLY if the token's `eat_nonce` commits to exactly that (wallet, pubkey).
 *
 * Three properties fall out of that and are worth naming, because they are what a reader should
 * check the code actually delivers:
 *
 * THE ENCLAVE NEVER NEEDS GAS. `TeeRegistry.register` is permissionless — the token is the
 * credential, not `msg.sender` — so this CLI runs OUTSIDE the enclave with an ordinary funded key.
 * The enclave holds no C2FLR, cannot be starved into failing to register, and its key is never
 * used for anything but signing settlements.
 *
 * THE RELAYER CANNOT SUBSTITUTE A KEY. It relays bytes it cannot alter: change the wallet and the
 * nonce check fails, change the token and the RSA signature fails. The worst it can do is refuse
 * to relay, and then anyone else can.
 *
 * THE TOKEN IS MINTED FOR ONE KEY. The nonce is `keccak256(wallet, pubkey)`, requested from the
 * launcher by the enclave itself at `GET /attestation`. A token captured off the wire is useless
 * for binding anything else.
 *
 * Usage:
 *   pnpm self-register                          # against http://localhost:$TEE_PORT
 *   pnpm self-register --url http://<vm-ip>:3000
 *   pnpm self-register --dry                    # print the call, send nothing
 */

import { loadConfig } from '../config.js';
import { assertUncompressed } from '../keys.js';
import { splitJwt, SIMULATED_TOKEN } from '../attestation.js';
import { makeChainReader } from '../chain/reads.js';
import { readRegisteredTee, readVtpmVerifier, registerAttested } from '../chain/registry.js';
import { errorMessage, log } from '../log.js';
import type { Address, Hex } from 'viem';

interface PubkeyResponse {
    readonly address?: string;
    readonly publicKey?: string;
}

interface AttestationResponse {
    readonly token?: string;
    readonly address?: string;
    readonly simulated?: boolean;
}

function flag(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    return process.argv[index + 1];
}

function has(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function relayerKey(): Hex {
    const raw = process.env['RELAYER_PRIVATE_KEY'] ?? process.env['DEPLOYER_PRIVATE_KEY'];
    if (!raw) {
        throw new Error(
            'set RELAYER_PRIVATE_KEY to any funded Coston2 key. It only pays gas: register() is ' +
                'permissionless and this key cannot influence what gets registered.',
        );
    }
    const key = raw.startsWith('0x') ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('RELAYER_PRIVATE_KEY is not a hex key');
    return key as Hex;
}

async function getJson<T>(url: string, what: string): Promise<T> {
    const res = await fetch(url).catch(() => undefined);
    if (!res || !res.ok) {
        throw new Error(`could not read ${what} at ${url} — is the engine running?`);
    }
    return (await res.json()) as T;
}

async function main(): Promise<void> {
    const config = loadConfig();
    const url = flag('url') ?? `http://localhost:${config.port}`;
    const dry = has('dry');

    const identity = await getJson<PubkeyResponse>(`${url}/pubkey`, 'the TEE public key');
    if (!identity.address || !identity.publicKey) {
        throw new Error(`${url}/pubkey did not return an address and a public key`);
    }
    // The same shape check `agent/app/src/seal.ts` makes before it spends anything.
    assertUncompressed(identity.publicKey);

    const attestation = await getJson<AttestationResponse>(
        `${url}/attestation`,
        'the attestation token',
    );
    if (!attestation.token) throw new Error(`${url}/attestation returned no token`);

    // The single most important guard in this file. A simulated token is a fixed string that
    // proves nothing; sending it would revert deep inside the verifier with an opaque parse error,
    // and an operator would reasonably read that as "the verifier is broken" rather than "this VM
    // is not a Confidential Space VM".
    if (attestation.simulated || attestation.token === SIMULATED_TOKEN) {
        throw new Error(
            'the engine returned a SIMULATED attestation token, which proves nothing and cannot ' +
                'be registered. Run this against a real Confidential Space VM with ' +
                'SIMULATE_ATTESTATION=false, or use `pnpm register-tee` for the dev path.',
        );
    }

    if (
        attestation.address &&
        attestation.address.toLowerCase() !== identity.address.toLowerCase()
    ) {
        throw new Error(
            `the token was minted for ${attestation.address} but /pubkey reports ` +
                `${identity.address} — the engine restarted between the two calls, so the nonce ` +
                `commits to a key it no longer holds. Re-run.`,
        );
    }

    const { header, payload, signature } = splitJwt(attestation.token);

    const chain = makeChainReader({
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        jobEscrow: config.jobEscrow,
        sealedCompetition: config.sealedCompetition,
        fromBlock: config.fromBlock,
    });

    const verifier = await readVtpmVerifier(chain.client, config.teeRegistry);
    const before = await readRegisteredTee(chain.client, config.teeRegistry);

    log.info('attested registration', {
        teeRegistry: config.teeRegistry,
        vtpmVerifier: verifier,
        pinnedImageDigest: before.imageDigest,
        currentlyBound: before.wallet,
        registering: identity.address,
    });

    if (dry) {
        log.info('dry run, sending nothing', {
            call: 'register(bytes,bytes,bytes,address,bytes)',
            headerBytes: (header.length - 2) / 2,
            payloadBytes: (payload.length - 2) / 2,
            signatureBytes: (signature.length - 2) / 2,
            teeWallet: identity.address,
            note: 'the contract will reject this unless the attested image digest equals the pin above',
        });
        return;
    }

    const result = await registerAttested({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        teeRegistry: config.teeRegistry,
        relayerKey: relayerKey(),
        header,
        payload,
        signature,
        teeWallet: identity.address as Address,
        teePublicKey: identity.publicKey as Hex,
    });

    const after = await readRegisteredTee(chain.client, config.teeRegistry);
    if (after.wallet.toLowerCase() !== identity.address.toLowerCase()) {
        throw new Error(
            `the transaction landed but activeTeeWallet reads ${after.wallet}, not ${identity.address}`,
        );
    }

    log.info('TEE bound by attestation', {
        wallet: after.wallet,
        imageDigest: after.imageDigest,
        tx: result.txHash,
        block: result.blockNumber.toString(),
        note: 'agents can now seal to this key and settlements will recover against it',
    });
}

main().catch((err) => {
    log.error('self-register failed', { reason: errorMessage(err) });
    process.exit(1);
});
