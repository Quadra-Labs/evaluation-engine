/**
 * attestation.ts — proving the key belongs to a real enclave running a known image.
 *
 * There are three ways this system can bind a TEE, and they are not equally strong. Saying so
 * plainly is the point of this file, because the weakest of them is the one the demo runs on.
 *
 *   1. `setActiveTee` — an owner transaction. It proves the OWNER says this key belongs to a TEE.
 *      That is a trusted operator, not a verified enclave. Honest name: development.
 *   2. `register` — a GCP Confidential Space vTPM token, verified by the contract, whose nonce
 *      binds the wallet and public key being registered so a token cannot be replayed for a
 *      different key. This module produces that token.
 *   3. `registerFccTee` — Flare's own `allow-tee-version` whitelist plus data-provider consensus.
 *      The strongest, and the one that needs no attestation code from us at all.
 *
 * The Flare reference never implemented (2): `fetchAttestationToken` returns the literal string
 * "SIMULATED_ATTESTATION_TOKEN" or throws, with the launcher call left as a TODO, while the file's
 * header claimed the pure pieces were unit tested. They were not — the package had no tests. The
 * launcher call is implemented below.
 */

import { encodePacked, keccak256, type Address, type Hex } from 'viem';
import { request as httpRequest } from 'node:http';
import { log } from './log.js';

/**
 * The Confidential Space launcher's unix socket. The container talks to it, not to a network
 * address, which is what makes the token unforgeable from outside the VM.
 */
const LAUNCHER_SOCKET = '/run/container_launcher/teeserver.sock';
const LAUNCHER_PATH = '/v1/token';

/**
 * The nonce `TeeRegistry.register` expects, binding a token to the exact identity it registers.
 *
 * Without it a token attesting "some enclave running image X" could be replayed to register any
 * key at all. `TeeRegistry.nonceFor` computes the same thing on chain; the two must agree byte for
 * byte, and `encodePacked` (not `encode`) is what makes them.
 */
export function nonceFor(teeWallet: Address, teePublicKey: Hex): Hex {
    return keccak256(encodePacked(['address', 'bytes'], [teeWallet, teePublicKey]));
}

export interface JwtParts {
    readonly header: Hex;
    readonly payload: Hex;
    readonly signature: Hex;
}

/**
 * Split a JWT into the three byte strings the contract verifies.
 *
 * base64url, not base64: `-` and `_` replace `+` and `/`, and the padding is stripped. Feeding a
 * base64url string to a base64 decoder does not fail — it silently produces different bytes, and
 * the signature check then fails with nothing to point at.
 */
export function splitJwt(jwt: string): JwtParts {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
        throw new Error(`expected a three-part JWT, got ${parts.length} parts`);
    }
    const [header, payload, signature] = parts as [string, string, string];
    const decode = (segment: string): Hex =>
        `0x${Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex')}`;
    return { header: decode(header), payload: decode(payload), signature: decode(signature) };
}

export interface AttestationRequest {
    readonly audience: string;
    readonly nonce: Hex;
    /** Anywhere that is not a real Confidential Space VM. Returns a clearly fake token. */
    readonly simulate: boolean;
}

/** What a simulated attestation returns. Deliberately not JWT-shaped: it must never parse. */
export const SIMULATED_TOKEN = 'SIMULATED_ATTESTATION_TOKEN';

function requestToken(audience: string, nonce: Hex): Promise<string> {
    const body = JSON.stringify({ audience, nonces: [nonce], token_type: 'OIDC' });

    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                socketPath: LAUNCHER_SOCKET,
                path: LAUNCHER_PATH,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8').trim();
                    if (res.statusCode !== 200) {
                        reject(
                            new Error(
                                `the Confidential Space launcher returned ${res.statusCode}: ` +
                                    text.slice(0, 256),
                            ),
                        );
                        return;
                    }
                    // The launcher returns the raw token, but has been observed to quote it.
                    resolve(text.replace(/^"|"$/g, ''));
                });
            },
        );
        req.on('error', (err) => reject(err));
        req.write(body);
        req.end();
    });
}

/**
 * Fetch an attestation token for this container.
 *
 * On the simulate path this returns a string that is obviously not a JWT, so a caller that forgets
 * to check `simulate` fails at `splitJwt` rather than registering something meaningless.
 */
export async function fetchAttestationToken(req: AttestationRequest): Promise<string> {
    if (req.simulate) {
        log.warn('returning a SIMULATED attestation token', {
            note: 'this proves nothing; set SIMULATE_ATTESTATION=false on a Confidential Space VM',
        });
        return SIMULATED_TOKEN;
    }

    try {
        return await requestToken(req.audience, req.nonce);
    } catch (err) {
        throw new Error(
            `could not reach the Confidential Space launcher at ${LAUNCHER_SOCKET} — this ` +
                `container is not running on a Confidential Space VM, or the socket is not ` +
                `mounted. Set SIMULATE_ATTESTATION=true for local development. ` +
                `(${err instanceof Error ? err.message : String(err)})`,
        );
    }
}

export interface RegisterCall {
    readonly header: Hex;
    readonly payload: Hex;
    readonly signature: Hex;
    readonly teeWallet: Address;
    readonly teePublicKey: Hex;
}

/** The five arguments of `TeeRegistry.register(bytes,bytes,bytes,address,bytes)`, in order. */
export function buildRegisterCall(
    identity: { readonly address: Address; readonly publicKey: Hex },
    jwt: string,
): RegisterCall {
    const { header, payload, signature } = splitJwt(jwt);
    return {
        header,
        payload,
        signature,
        teeWallet: identity.address,
        teePublicKey: identity.publicKey,
    };
}
