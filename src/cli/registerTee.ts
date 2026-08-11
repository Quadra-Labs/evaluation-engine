/**
 * registerTee.ts — bind this engine's key into `TeeRegistry` on the development path.
 *
 * This is the transaction that turns a deployment from "looks healthy, can do nothing" into a
 * working system. Before it, `activeTeeWallet()` is the zero address: every settlement path
 * recovers a signature and compares it to that, and no signature recovers to zero, so `scoreJob`,
 * `settle` and all three `*FromTee` entrypoints revert. Agents cannot even deliver, because
 * `agent/app/src/seal.ts` reads `activeTeePublicKey()` and refuses to seal to an empty key.
 *
 * It is also the WEAKEST of the three bindings — an owner assertion, not an attestation. Run it to
 * get the system moving, and read `docs/deploy.md` for the two stronger paths.
 *
 * The key comes from a running engine's `/pubkey` rather than from a flag, so the thing that is
 * registered is necessarily the thing that is running. Passing a key by hand is how a registry
 * ends up naming a key no process holds.
 *
 * Usage:
 *   pnpm register-tee                        # read the key from http://localhost:$TEE_PORT
 *   pnpm register-tee --url http://host:3000
 *   pnpm register-tee --digest sha256:abc...  # overrides TEE_IMAGE_DIGEST
 */

import { deployerKey, loadConfig } from '../config.js';
import { assertUncompressed } from '../keys.js';
import { bindTee, readRegisteredTee } from '../chain/registry.js';
import { makeChainReader } from '../chain/reads.js';
import { errorMessage, log } from '../log.js';
import type { Address, Hex } from 'viem';

interface PubkeyResponse {
    readonly address?: string;
    readonly publicKey?: string;
}

function flag(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    return process.argv[index + 1];
}

async function main(): Promise<void> {
    const config = loadConfig();
    const url = flag('url') ?? `http://localhost:${config.port}`;

    const res = await fetch(`${url}/pubkey`).catch(() => undefined);
    if (!res || !res.ok) {
        throw new Error(
            `could not read ${url}/pubkey — start the engine first (pnpm dev), or pass --url`,
        );
    }

    const body = (await res.json()) as PubkeyResponse;
    if (!body.address || !body.publicKey) {
        throw new Error(`${url}/pubkey did not return an address and a public key`);
    }
    // The same assertion `agent/app/src/seal.ts` makes before it spends anything. Failing here is
    // free; failing there is an agent that cannot work against a registry we just wrote.
    assertUncompressed(body.publicKey);

    // An empty digest is deliberate and better than a placeholder: quadra-verify reports the image
    // check as `skipped` for an empty one, and as a PASS for a fake one that attests to nothing.
    const digest = flag('digest') ?? config.teeImageDigest;
    if (!digest) {
        log.warn('registering with an EMPTY image digest', {
            note:
                'the verifier will report the image check as skipped, which is honest; a ' +
                'placeholder like sha256:dev would make it report a meaningless pass',
        });
    }

    const chain = makeChainReader({
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        jobEscrow: config.jobEscrow,
        sealedCompetition: config.sealedCompetition,
        fromBlock: config.fromBlock,
    });

    const before = await readRegisteredTee(chain.client, config.teeRegistry);
    log.info('current binding', { wallet: before.wallet, imageDigest: before.imageDigest });

    const result = await bindTee({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        teeRegistry: config.teeRegistry,
        ownerKey: deployerKey(),
        teeWallet: body.address as Address,
        teePublicKey: body.publicKey as Hex,
        imageDigest: digest,
    });

    const after = await readRegisteredTee(chain.client, config.teeRegistry);
    log.info('TEE bound', {
        wallet: after.wallet,
        imageDigest: after.imageDigest || '(empty)',
        tx: result.txHash,
        block: result.blockNumber.toString(),
    });

    if (after.wallet.toLowerCase() !== body.address.toLowerCase()) {
        throw new Error(
            `the transaction landed but activeTeeWallet reads ${after.wallet}, not ${body.address}`,
        );
    }
}

main().catch((err) => {
    log.error('register-tee failed', { reason: errorMessage(err) });
    process.exit(1);
});
