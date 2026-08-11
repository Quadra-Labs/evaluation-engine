/**
 * main.ts — the FCC extension entrypoint.
 *
 * The difference from `src/main.ts` fits in one line: THIS PROCESS HOLDS NO KEY. There is no
 * `bootTeeIdentity`, no `signing` context on the engine, and the decryptors route every unwrap to
 * Flare's TEE node over the loopback sign port. That is the whole substance of the FCC claim —
 * on the EIP-712 path "the operator cannot read your result" rests on the operator not reading its
 * own process memory, and here the key was generated inside the node at boot and never left it.
 *
 * It also does not sign. The handlers return abi-encoded bytes and the node signs the ActionResult
 * around them, which is what `TeeActionResult.recoverSigner` checks on chain.
 *
 * The container runs two processes joined by `wait -n`: Flare's `server` binary and this one. If
 * either exits the container exits, because an extension whose node has died answers nothing while
 * still looking alive to a health check.
 */

import { loadConfig } from '../config.js';
import { makeChainReader } from '../chain/reads.js';
import { nodeDecryptors } from '../decrypt.js';
import { makeEngine } from '../engine.js';
import { NodeClient } from './base/node.js';
import { ExtensionServer } from './base/server.js';
import { makeRegister, reportState } from './app/handlers.js';
import { EXTENSION_PORT, SIGN_PORT, VERSION } from './app/config.js';
import { errorMessage, log } from '../log.js';
import { resolveVotingEpoch } from 'quadra-core/voting-epoch';

async function boot(): Promise<void> {
    const config = loadConfig();

    const chain = makeChainReader({
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        jobEscrow: config.jobEscrow,
        sealedCompetition: config.sealedCompetition,
        fromBlock: config.fromBlock,
    });

    const epoch = await resolveVotingEpoch(chain.client);
    if (epoch.warning) log.warn('voting epoch', { detail: epoch.warning });

    const node = new NodeClient(SIGN_PORT);
    log.info('routing decryption to the TEE node', { signPort: SIGN_PORT, url: node.baseUrl });

    const engine = makeEngine({
        chain,
        decryptors: nodeDecryptors(node),
        policy: {
            daBaseUrl: config.daBaseUrl,
            daApiKey: config.daApiKey,
            defaultFeed: config.defaultFeed,
            defaultLifetimeSecs: config.defaultLifetimeSecs,
            votingEpoch: epoch.epoch,
        },
        // Under FCC the measured code hash IS the image identity, and the node reports it.
        // TEE_CODE_HASH is injected by the compose stack from the proxy's /info.
        teeImageDigest: process.env['TEE_CODE_HASH'] ?? config.teeImageDigest,
        // No signing context: this instance cannot sign an EIP-712 settlement and must not try.
        signing: undefined,
    });

    const server = new ExtensionServer(
        EXTENSION_PORT,
        VERSION,
        makeRegister({ engine }),
        reportState,
    );

    await server.listenAndServe();
    log.info('fcc extension ready', {
        version: VERSION,
        chainId: config.chainId,
        jobEscrow: config.jobEscrow,
        sealedCompetition: config.sealedCompetition,
    });

    const shutdown = (signal: string) => {
        log.info('shutting down', { signal });
        void server.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

boot().catch((err) => {
    log.error('fcc boot failed', { reason: errorMessage(err) });
    process.exit(1);
});
