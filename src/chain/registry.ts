/**
 * registry.ts — reading and writing the TEE's binding in `TeeRegistry`.
 *
 * `activeTeeWallet` is the hinge the whole system turns on. Every settlement path recovers a
 * signature and compares the signer to it, and `agent/app/src/seal.ts` reads `activeTeePublicKey`
 * before it spends anything. Until this binding exists, the deployment looks healthy and can do
 * nothing: no agent can seal, no score can land.
 *
 * The write here is the DEV path — `setActiveTee`, an owner call. It is not attestation. It says
 * "the owner asserts this key belongs to a TEE running this image", and the honest description of
 * that is a trusted operator, not a verified enclave. The two stronger paths are `register` (a vTPM
 * attestation the contract checks) and `registerFccTee` (Flare's own code-version whitelist plus
 * data-provider consensus). This module exists so the system can run end to end before either.
 *
 * A transaction is not confirmed when it is broadcast. `bindTee` waits for the receipt and checks
 * the status, because a dropped or reverted binding that reported success would leave every agent
 * sealing to a key nothing on chain recognises.
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
import { teeRegistryAbi } from './abis.js';
import { coston2 } from './reads.js';

export interface RegisteredTee {
    readonly wallet: Address;
    readonly publicKey: Hex;
    readonly imageDigest: string;
}

/** The zero address, which is what `activeTeeWallet` reads as before anything is bound. */
export const NO_TEE = '0x0000000000000000000000000000000000000000' as const;

export async function readRegisteredTee(
    client: PublicClient,
    teeRegistry: Address,
): Promise<RegisteredTee> {
    const [wallet, publicKey, imageDigest] = await Promise.all([
        client.readContract({
            address: teeRegistry,
            abi: teeRegistryAbi,
            functionName: 'activeTeeWallet',
        }) as Promise<Address>,
        client.readContract({
            address: teeRegistry,
            abi: teeRegistryAbi,
            functionName: 'activeTeePublicKey',
        }) as Promise<Hex>,
        client.readContract({
            address: teeRegistry,
            abi: teeRegistryAbi,
            functionName: 'expectedImageDigest',
        }) as Promise<string>,
    ]);
    return { wallet, publicKey, imageDigest };
}

/**
 * How this instance stands against what the chain publishes. BUGS.md 36.
 *
 * The enclave mints a FRESH key at every boot — correct for a TEE, since a persisted key is a key
 * that outlived the attestation that vouched for it. The cost is that after any restart the
 * published key is stale, and **every delivery an agent seals in the meantime is permanently
 * unopenable**: the job then scores zero on an empty submission (BUGS.md 29's
 * `undecryptable-payload`) and the agent's Passport carries it. Nothing automates the
 * re-registration, so the state this function names is the difference between noticing in a minute
 * and noticing after a night of zeroes.
 *
 *   `bound`           the chain names this instance's wallet AND its public key. Normal.
 *   `stale-key`       the wallet matches and the PUBLIC KEY does not. The dangerous one — see below.
 *   `other-instance`  the chain names a different enclave. Ours must not be sealed to.
 *   `unregistered`    nothing is bound, or the registry was revoked (`revokeTee`, BUGS.md 35).
 *
 * `stale-key` deserves its own state rather than folding into "registered". Comparing the WALLET
 * alone reads as healthy in two situations where agents cannot reach us: a restart that re-bound
 * the wallet but not the key, and a `setActiveTee` called with a placeholder public key — which is
 * not hypothetical, because `Deploy.s.sol` defaults it to a one-byte `hex"04"` (BUGS.md 15). In
 * both, `activeTeeWallet` is right, settlements verify, and every sealed payload is addressed to
 * something nobody can open.
 */
export type TeeBinding = 'bound' | 'stale-key' | 'other-instance' | 'unregistered';

export function bindingOf(
    registered: RegisteredTee,
    self: {
        readonly address: Address;
        readonly publicKey: Hex;
    },
): TeeBinding {
    if (registered.wallet === NO_TEE) return 'unregistered';
    if (registered.wallet.toLowerCase() !== self.address.toLowerCase()) return 'other-instance';
    // Case-insensitive on purpose: viem returns lower-case hex and a hand-written `setActiveTee`
    // may not, and a case difference is not a different key.
    return registered.publicKey.toLowerCase() === self.publicKey.toLowerCase()
        ? 'bound'
        : 'stale-key';
}

/** The attestation verifier the registry is pinned to, or the zero address on a dev deployment. */
export async function readVtpmVerifier(
    client: PublicClient,
    teeRegistry: Address,
): Promise<Address> {
    return (await client.readContract({
        address: teeRegistry,
        abi: teeRegistryAbi,
        functionName: 'vtpm',
    })) as Address;
}

export interface AttestArgs {
    readonly rpcUrl: string;
    readonly chainId: number;
    readonly teeRegistry: Address;
    /**
     * ANY funded key. `register` is permissionless — the token is the credential, not the sender.
     *
     * This is the property that keeps the enclave gasless: it never needs a funded wallet, never
     * holds C2FLR, and cannot be starved into failing to register. Whoever relays pays, and they
     * cannot alter what is registered because the nonce binds the token to one exact key.
     */
    readonly relayerKey: Hex;
    /** The base64url-decoded JWT parts, from `splitJwt`. */
    readonly header: Hex;
    readonly payload: Hex;
    readonly signature: Hex;
    readonly teeWallet: Address;
    readonly teePublicKey: Hex;
}

/**
 * Bind the enclave's key through the attested path.
 *
 * Simulates first, so a rejected attestation surfaces as the contract's own named error —
 * `BadImageDigest`, `BadNonce`, `VtpmUnset`, or one of the verifier's — instead of as a burnt
 * transaction with no reason string. Those five names are the entire diagnostic surface for
 * "why will my enclave not register", so losing them to an unsimulated send is expensive.
 */
export async function registerAttested(args: AttestArgs): Promise<BindResult> {
    const chain = args.chainId === coston2.id ? coston2 : undefined;
    const account = privateKeyToAccount(args.relayerKey);

    const publicClient = createPublicClient({
        ...(chain ? { chain } : {}),
        transport: http(args.rpcUrl),
    }) as PublicClient;

    const verifier = await readVtpmVerifier(publicClient, args.teeRegistry);
    if (verifier === NO_TEE) {
        throw new Error(
            'this TeeRegistry was deployed with no vTPM verifier, so register() always reverts ' +
                'VtpmUnset. The verifier is immutable — binding an attested key needs a redeploy ' +
                'with DEPLOY_VTPM=true. Use `pnpm register-tee` for the dev path meanwhile.',
        );
    }

    const { request } = await publicClient.simulateContract({
        account,
        address: args.teeRegistry,
        abi: teeRegistryAbi,
        functionName: 'register',
        args: [args.header, args.payload, args.signature, args.teeWallet, args.teePublicKey],
    });

    const wallet = createWalletClient({
        account,
        ...(chain ? { chain } : {}),
        transport: http(args.rpcUrl),
    });

    const txHash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error(`register reverted in ${txHash}`);
    return { txHash, blockNumber: receipt.blockNumber };
}

export interface BindArgs {
    readonly rpcUrl: string;
    readonly chainId: number;
    readonly teeRegistry: Address;
    /** The contract owner's key. `setActiveTee` is onlyOwner. NOT the TEE's own key. */
    readonly ownerKey: Hex;
    readonly teeWallet: Address;
    /** Uncompressed `0x04 || X || Y`. Anything else and every agent refuses to seal. */
    readonly teePublicKey: Hex;
    /**
     * The image this instance runs. `setActiveTee` overwrites `expectedImageDigest` as a side
     * effect, so this argument can silently move the production attestation pin — pass the real
     * digest, or the empty string, and never a placeholder. An empty digest makes the verifier's
     * image check report `skipped`; a fake one makes it report a pass that attests to nothing.
     */
    readonly imageDigest: string;
}

export interface BindResult {
    readonly txHash: Hex;
    readonly blockNumber: bigint;
}

export async function bindTee(args: BindArgs): Promise<BindResult> {
    const chain = args.chainId === coston2.id ? coston2 : undefined;
    const account = privateKeyToAccount(args.ownerKey);

    const publicClient = createPublicClient({
        ...(chain ? { chain } : {}),
        transport: http(args.rpcUrl),
    }) as PublicClient;

    const owner = (await publicClient.readContract({
        address: args.teeRegistry,
        abi: teeRegistryAbi,
        functionName: 'owner',
    })) as Address;

    if (owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(
            `setActiveTee is onlyOwner: TeeRegistry owner is ${owner} but DEPLOYER_PRIVATE_KEY ` +
                `derives to ${account.address}`,
        );
    }

    const wallet = createWalletClient({
        account,
        ...(chain ? { chain } : {}),
        transport: http(args.rpcUrl),
    });

    // Simulate first so a revert surfaces as a named error here rather than as a burnt transaction.
    const { request } = await publicClient.simulateContract({
        account,
        address: args.teeRegistry,
        abi: teeRegistryAbi,
        functionName: 'setActiveTee',
        args: [args.teeWallet, args.teePublicKey, args.imageDigest],
    });

    const txHash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
        throw new Error(`setActiveTee reverted in ${txHash}`);
    }
    return { txHash, blockNumber: receipt.blockNumber };
}
