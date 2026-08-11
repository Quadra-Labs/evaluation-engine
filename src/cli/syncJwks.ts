/**
 * syncJwks.ts — mirror Google's Confidential Space signing keys into the on-chain verifier.
 *
 * The verifier checks an RS256 signature, which means it needs Google's public keys, which means
 * something has to put them there. Google rotates them on its own schedule and publishes the
 * current set at a well-known URL; this walks that set and writes any key the contract does not
 * already have.
 *
 * THIS IS THE SYSTEM'S RESIDUAL TRUST, and it should be named rather than buried: the chain does
 * not fetch from Google, so the root of trust is the owner faithfully mirroring what Google
 * publishes. A malicious or compromised owner could install a key they control and then mint
 * tokens attesting to anything. That is strictly weaker than Flare Confidential Compute, where
 * data-provider consensus replaces this step entirely — and it is exactly why `TeeRegistry` keeps
 * `registerFccTee` as a third path rather than treating this one as the destination.
 *
 * Two mitigations are cheap and both are here: keys are only ever ADDED (never silently swapped
 * for a different modulus under the same kid without saying so), and every write is logged with
 * the kid so the on-chain history is auditable against Google's published set.
 *
 * Run it before the first registration, and again whenever `self-register` fails with
 * `UnknownKey` — that is the signal Google rotated.
 *
 * Usage:
 *   pnpm sync-jwks              # write any missing keys
 *   pnpm sync-jwks --dry        # report what is missing, write nothing
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    type Address,
    type Hex,
    type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, deployerKey } from '../config.js';
import { vtpmVerifierAbi } from '../chain/abis.js';
import { readVtpmVerifier } from '../chain/registry.js';
import { coston2 } from '../chain/reads.js';
import { fetchJson } from '../http/fetch.js';
import { errorMessage, log } from '../log.js';

/**
 * Confidential Space tokens are issued by this service, and its OpenID discovery document names
 * the JWKS URI. Resolving through discovery rather than hardcoding the JWKS URL is deliberate:
 * the discovery document is the stable, documented entry point and the key URL behind it has
 * moved before.
 */
const OPENID_CONFIG =
    'https://confidentialcomputing.googleapis.com/.well-known/openid-configuration';

interface OpenIdConfig {
    readonly jwks_uri?: string;
}

interface Jwk {
    readonly kid?: string;
    readonly kty?: string;
    readonly alg?: string;
    readonly use?: string;
    /** base64url big-endian modulus. */
    readonly n?: string;
    /** base64url big-endian exponent. */
    readonly e?: string;
}

interface Jwks {
    readonly keys?: readonly Jwk[];
}

/** base64url (unpadded, `-`/`_`) to bytes. JWK numbers are big-endian with no leading zero byte. */
function b64urlToHex(value: string): Hex {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return `0x${Buffer.from(b64, 'base64').toString('hex')}`;
}

function has(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
    const config = loadConfig();
    const dry = has('dry');

    const chain = config.chainId === coston2.id ? coston2 : undefined;
    const publicClient = createPublicClient({
        ...(chain ? { chain } : {}),
        transport: http(config.rpcUrl),
    }) as PublicClient;

    const verifier = await readVtpmVerifier(publicClient, config.teeRegistry);
    if (verifier === '0x0000000000000000000000000000000000000000') {
        throw new Error(
            'this TeeRegistry has no vTPM verifier, so there is nowhere to put the keys. The ' +
                'verifier is immutable — deploy with DEPLOY_VTPM=true.',
        );
    }

    const discovery = await fetchJson<OpenIdConfig>(OPENID_CONFIG);
    const jwksUri = discovery.jwks_uri;
    if (!jwksUri) throw new Error(`${OPENID_CONFIG} did not name a jwks_uri`);

    const jwks = await fetchJson<Jwks>(jwksUri);
    const keys = jwks.keys ?? [];
    if (keys.length === 0) throw new Error(`${jwksUri} returned no keys`);

    log.info('fetched Google JWKS', { jwksUri, keys: keys.length, verifier });

    // Only RSA signing keys are usable. Google has published EC keys alongside them before, and
    // an EC modulus fed to pkcs1Sha256 would be accepted at write time and fail every
    // verification afterwards with an unexplained BadSignature.
    const usable = keys.filter((k) => k.kty === 'RSA' && k.n && k.e && k.kid);
    if (usable.length === 0) throw new Error('the JWKS carried no RSA keys');

    const missing: Jwk[] = [];
    for (const key of usable) {
        const kidBytes = `0x${Buffer.from(key.kid as string, 'utf8').toString('hex')}` as Hex;
        const present = (await publicClient.readContract({
            address: verifier as Address,
            abi: vtpmVerifierAbi,
            functionName: 'hasKey',
            args: [kidBytes],
        })) as boolean;
        if (present) {
            log.debug('key already on chain', { kid: key.kid });
        } else {
            missing.push(key);
        }
    }

    if (missing.length === 0) {
        log.info('every published Google key is already on chain', { checked: usable.length });
        return;
    }

    log.info('keys to write', { count: missing.length, kids: missing.map((k) => k.kid).join(',') });

    if (dry) {
        log.info('dry run, sending nothing');
        return;
    }

    const account = privateKeyToAccount(deployerKey());
    const owner = (await publicClient.readContract({
        address: verifier as Address,
        abi: vtpmVerifierAbi,
        functionName: 'owner',
    })) as Address;
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(
            `setKey is onlyOwner: the verifier's owner is ${owner} but DEPLOYER_PRIVATE_KEY ` +
                `derives to ${account.address}`,
        );
    }

    const wallet = createWalletClient({
        account,
        ...(chain ? { chain } : {}),
        transport: http(config.rpcUrl),
    });

    for (const key of missing) {
        const kidBytes = `0x${Buffer.from(key.kid as string, 'utf8').toString('hex')}` as Hex;
        const exponent = b64urlToHex(key.e as string);
        const modulus = b64urlToHex(key.n as string);

        // The contract enforces this too, but failing here names the key rather than reverting
        // with a bare require string halfway through a multi-key sync.
        if ((modulus.length - 2) / 2 < 256) {
            log.warn('skipping a key whose modulus is under 2048 bits', { kid: key.kid });
            continue;
        }

        const { request } = await publicClient.simulateContract({
            account,
            address: verifier as Address,
            abi: vtpmVerifierAbi,
            functionName: 'setKey',
            args: [kidBytes, exponent, modulus],
        });
        const txHash = await wallet.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== 'success') throw new Error(`setKey reverted for kid ${key.kid}`);

        log.info('key written', {
            kid: key.kid,
            modulusBytes: (modulus.length - 2) / 2,
            tx: txHash,
        });
    }

    log.info('JWKS sync complete', {
        written: missing.length,
        note: 're-run this whenever self-register fails with UnknownKey — that means Google rotated',
    });
}

main().catch((err) => {
    log.error('sync-jwks failed', { reason: errorMessage(err) });
    process.exit(1);
});
