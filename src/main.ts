/**
 * main.ts — the EIP-712 service entrypoint.
 *
 * Boot order is deliberate: everything that can be wrong is discovered BEFORE the port opens. An
 * engine that starts, answers `/pubkey`, gets bound as the active TEE and then fails its first
 * real settlement has cost someone an escrowed job; failing at boot costs a restart.
 *
 * The voting-epoch read is the one piece of boot-time chain I/O. `feeds.ts` in quadra-core stays
 * I/O-free on purpose — the enclave image and the verifier both import it, and a verifier that
 * dials the chain it audits is a weaker verifier — so the geometry is resolved here and passed in.
 * `resolveVotingEpoch` never throws: a failed read falls back to the compiled-in Coston2 values
 * and warns, and a DIVERGENCE warns loudly naming both numbers, because a plausible-but-wrong
 * voting round produces a real finalized feed from the wrong instant and nothing reports an error.
 */

import { loadConfig } from './config.js';
import { bootTeeIdentity } from './keys.js';
import { makeChainReader } from './chain/reads.js';
import { bindingOf, readRegisteredTee, NO_TEE } from './chain/registry.js';
import { localDecryptors } from './decrypt.js';
import { makeEngine } from './engine.js';
import { makeService } from './server.js';
import { errorMessage, log } from './log.js';
import { resolveVotingEpoch } from 'quadra-core/voting-epoch';

export const VERSION = '1.0.0';

async function boot(): Promise<void> {
    const config = loadConfig();
    const identity = bootTeeIdentity();

    const chain = makeChainReader({
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        jobEscrow: config.jobEscrow,
        sealedCompetition: config.sealedCompetition,
        fromBlock: config.fromBlock,
    });

    const epoch = await resolveVotingEpoch(chain.client);
    if (epoch.warning) log.warn('voting epoch', { detail: epoch.warning });
    log.info('voting epoch resolved', {
        firstVotingRoundUnix: epoch.epoch.firstVotingRoundUnix,
        epochSecs: epoch.epoch.epochSecs,
        fromChain: epoch.fromChain,
    });

    // Not fatal. A fresh instance is SUPPOSED to be unbound until `pnpm register-tee` runs, and
    // refusing to start would make the binding impossible: the CLI reads the key from this
    // process's /pubkey.
    const registered = await readRegisteredTee(chain.client, config.teeRegistry).catch((err) => {
        log.warn('could not read the TEE registry', { reason: errorMessage(err) });
        return undefined;
    });

    if (registered) {
        if (registered.wallet === NO_TEE) {
            log.warn('no TEE is bound on chain', {
                note: 'nothing can settle and no agent can seal until setActiveTee names a key',
            });
        } else if (registered.wallet.toLowerCase() !== identity.address.toLowerCase()) {
            log.warn('a DIFFERENT TEE is bound on chain', {
                bound: registered.wallet,
                thisInstance: identity.address,
                note: 'agents are sealing to the bound key, which this instance cannot open',
            });
        } else if (bindingOf(registered, identity) === 'stale-key') {
            // THE RESTART CASE, and the reason it needs its own branch: the wallet matches, so
            // every check that looks at `activeTeeWallet` reads as healthy, while the PUBLIC KEY
            // agents seal to is one this process cannot open. The enclave mints a fresh key at
            // every boot, so a VM that rebooted overnight sits here looking correct and silently
            // turning every delivery into a permanent zero (BUGS.md 36, then 29).
            log.warn('the PUBLIC KEY on chain is not the one this instance holds', {
                onChain: registered.publicKey,
                thisInstance: identity.publicKey,
                remedy: 'run pnpm self-register (or register-tee on the dev path) NOW',
                note: 'anything sealed to the published key in the meantime is unopenable forever',
            });
        } else {
            log.info('this instance is the bound TEE', { address: identity.address });
        }
        if (registered.imageDigest && registered.imageDigest !== config.teeImageDigest) {
            log.warn('the registered image digest is not what this instance reports', {
                registered: registered.imageDigest,
                local: config.teeImageDigest || '(empty)',
                note: 'quadra-verify compares the two and will report a mismatch',
            });
        }
    }

    const engine = makeEngine({
        chain,
        decryptors: localDecryptors(identity.privateKey),
        policy: {
            daBaseUrl: config.daBaseUrl,
            daApiKey: config.daApiKey,
            defaultFeed: config.defaultFeed,
            defaultLifetimeSecs: config.defaultLifetimeSecs,
            votingEpoch: epoch.epoch,
        },
        teeImageDigest: config.teeImageDigest,
        signing: {
            chainId: config.chainId,
            jobEscrow: config.jobEscrow,
            sealedCompetition: config.sealedCompetition,
            privateKey: identity.privateKey,
        },
    });

    const server = makeService({ engine, chain, config, identity, version: VERSION });

    server.listen(config.port, () => {
        log.info('evaluation engine listening', {
            port: config.port,
            chainId: config.chainId,
            tee: identity.address,
            // Says which one is true rather than only complaining about the unset case, so an
            // operator who believes they configured a token can confirm it from the boot line.
            validateAuth: config.internalToken === undefined ? 'none' : 'x-intake-token',
        });
        if (config.internalToken === undefined) {
            log.warn(
                'INTAKE_INTERNAL_TOKEN is unset: /validate, /score-job, /score-market and ' +
                    '/settle-competition are unauthenticated. Fine on loopback, not on a shared host',
            );
        }
    });

    // Graceful shutdown so an in-flight settlement finishes rather than being cut mid-signature.
    // The compose stack sends SIGTERM; Ctrl-C sends SIGINT.
    const shutdown = (signal: string) => {
        log.info('shutting down', { signal });
        server.close(() => process.exit(0));
        // A hung keep-alive connection must not hold the container open forever.
        setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

boot().catch((err) => {
    log.error('boot failed', { reason: errorMessage(err) });
    process.exit(1);
});
