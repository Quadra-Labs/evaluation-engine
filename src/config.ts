/**
 * config.ts — everything this workload reads from its environment, resolved once at boot.
 *
 * Two rules shape this file.
 *
 * ADDRESSES ARE NEVER HARDCODED. They come from `contracts/deployments/<chainId>.json` through
 * quadra-core's loader, which walks up from this checkout to find it. A redeploy then needs no
 * change here, which is the whole point: the deployment is disposable and will be replaced before
 * submission. An env var may override, for pointing at a fork or an older deployment.
 *
 * A MISSING ADDRESS IS A BOOT FAILURE, not a runtime one. An engine that starts with no JobEscrow
 * looks healthy, answers `/pubkey`, gets registered as the active TEE, and then fails the first
 * settlement of a real job with money already escrowed. Failing at boot costs nothing.
 */

import { loadDeployment } from 'quadra-core/deployments';
import type { Address, Hex } from 'viem';

export interface EngineConfig {
    readonly chainId: number;
    readonly rpcUrl: string;
    readonly jobEscrow: Address;
    readonly sealedCompetition: Address;
    readonly teeRegistry: Address;
    /** The floor for log scans. Scanning from genesis over a 30-block-per-request cap is hours. */
    readonly fromBlock: bigint;

    readonly daBaseUrl: string;
    readonly daApiKey: string | undefined;

    /** Recorded in every receipt and compared by quadra-verify. Empty is honest; a fake is not. */
    readonly teeImageDigest: string;

    /** Used only when a competition's evaluatorId does not name an asset. Jobs never fall back. */
    readonly defaultFeed: string;
    readonly defaultLifetimeSecs: number;

    readonly port: number;

    /**
     * Shared secret the intake engine presents on `/validate`, as `x-intake-token`.
     *
     * Optional, and unset means no check — a local dev run should not need a secret. But `/validate`
     * is the call that decides whether an escrow pays out, so on any host where the port is not
     * strictly loopback this should be set on both sides. The intake engine already sends the
     * header whenever its own `INTAKE_INTERNAL_TOKEN` is set.
     */
    readonly internalToken: string | undefined;
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new ConfigError(`${name} is required`);
    return value;
}

function optionalAddress(name: string): Address | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new ConfigError(`${name} is not an address: ${value}`);
    }
    return value as Address;
}

function numberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new ConfigError(`${name} is not a number: ${raw}`);
    return parsed;
}

/**
 * Resolve one address: the env var wins, then the deployment file. Naming both in the error
 * matters — "jobEscrow is not configured" sends a reader to the wrong file half the time.
 */
function resolveAddress(envName: string, fromFile: string | undefined, chainId: number): Address {
    const override = optionalAddress(envName);
    if (override) return override;
    if (fromFile && /^0x[0-9a-fA-F]{40}$/.test(fromFile)) return fromFile as Address;
    throw new ConfigError(
        `no address for ${envName}: it is absent from contracts/deployments/${chainId}.json ` +
            `and ${envName} is unset`,
    );
}

export function loadConfig(): EngineConfig {
    const chainId = numberEnv('CHAIN_ID', 114);
    const deployment = loadDeployment(chainId);

    if (!deployment) {
        throw new ConfigError(
            `no contracts/deployments/${chainId}.json found from this checkout — set CONTRACTS_DIR, ` +
                `or set JOB_ESCROW, SEALED_COMPETITION and TEE_REGISTRY explicitly`,
        );
    }

    return {
        chainId,
        rpcUrl: process.env['CHAIN_RPC_URL'] ?? 'https://coston2-api.flare.network/ext/C/rpc',
        jobEscrow: resolveAddress('JOB_ESCROW', deployment.jobEscrow, chainId),
        sealedCompetition: resolveAddress(
            'SEALED_COMPETITION',
            deployment.sealedCompetition,
            chainId,
        ),
        teeRegistry: resolveAddress('TEE_REGISTRY', deployment.teeRegistry, chainId),
        fromBlock: BigInt(process.env['FROM_BLOCK'] ?? deployment.fromBlock ?? 0),

        daBaseUrl: process.env['DA_URL'] ?? 'https://ctn2-data-availability.flare.network',
        daApiKey: process.env['DA_API_KEY'] || undefined,

        // Deliberately not defaulted to anything that looks real. DEPLOYMENT-STATE records the
        // live registry still holding the placeholder `sha256:dev`, against which the verifier's
        // image check either fails for every honest receipt or passes against nothing.
        teeImageDigest: process.env['TEE_IMAGE_DIGEST'] ?? '',

        defaultFeed: process.env['DEFAULT_FEED'] ?? 'BTC/USD',
        defaultLifetimeSecs: numberEnv('DEFAULT_LIFETIME_SECS', 3600),

        port: numberEnv('TEE_PORT', 3000),
        internalToken: process.env['INTAKE_INTERNAL_TOKEN'] || undefined,
    };
}

/** The owner key that `setActiveTee` needs. Only the register-tee CLI reads this. */
export function deployerKey(): Hex {
    const raw = requireEnv('DEPLOYER_PRIVATE_KEY');
    const withPrefix = raw.startsWith('0x') ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
        throw new ConfigError('DEPLOYER_PRIVATE_KEY is not a 32-byte hex key');
    }
    return withPrefix as Hex;
}
