/**
 * proxy.ts — the read-only client for the extension proxy.
 *
 * The proxy is the public half of an FCC deployment: the TEE machine itself sits behind a firewall
 * and is not reachable, so anything outside asks the proxy. This module needs it for exactly one
 * thing that matters — the TEE's public key.
 *
 * THE KEY MUST BE REBUILT, NOT CONCATENATED. `/info` reports the point's X and Y coordinates
 * SEPARATELY, as numbers or short hex, and an uncompressed secp256k1 public key is
 * `0x04 || pad32(X) || pad32(Y)`. Joining the two reported values without the `0x04` tag, or
 * without left-padding each to 32 bytes, produces something that looks like a plausible key,
 * passes a cursory eye, and encrypts to nothing recoverable. That key then goes into
 * `TeeRegistry.activeTeePublicKey`, every agent seals to it, and the failure appears at settlement
 * with the escrow already funded.
 *
 * The result-polling half of the proxy API is deliberately absent. Requesting instructions and
 * relaying results belongs to `scheduler`, not to the workload being relayed.
 */

import { fetchJson } from '../http/fetch.js';
import { assertUncompressed } from '../keys.js';
import type { Hex } from 'viem';

export interface TeeInfo {
    readonly machineData?: {
        readonly codeHash?: string;
        readonly extensionId?: string | number;
        readonly initialOwner?: string;
        readonly platform?: string;
    };
    readonly teeInfo?: {
        readonly publicKey?: { readonly x?: string | number; readonly y?: string | number };
    };
}

export class NotReadyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotReadyError';
    }
}

/** One coordinate, left-padded to 32 bytes. Accepts decimal or hex, with or without 0x. */
function coordinate(value: string | number | undefined, name: string): string {
    if (value === undefined || value === null || value === '') {
        throw new NotReadyError(`the proxy reported no ${name} coordinate for the TEE public key`);
    }
    const raw = String(value);
    const asBigInt = raw.startsWith('0x') || raw.startsWith('0X') ? BigInt(raw) : BigInt(raw);
    const hex = asBigInt.toString(16);
    if (hex.length > 64) throw new Error(`the ${name} coordinate does not fit in 32 bytes`);
    return hex.padStart(64, '0');
}

export class ProxyClient {
    constructor(
        private readonly baseUrl: string,
        private readonly timeoutMs = 15_000,
    ) {}

    async info(): Promise<TeeInfo> {
        return fetchJson<TeeInfo>(`${this.baseUrl}/info`, undefined, {
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * The 65-byte uncompressed public key, ready for `TeeRegistry.registerFccTee` and for the
     * agents that read it back off the chain.
     */
    async publicKey(): Promise<Hex> {
        const info = await this.info();
        const point = info.teeInfo?.publicKey;
        if (!point) throw new NotReadyError('the proxy reported no TEE public key yet');
        const key = `0x04${coordinate(point.x, 'x')}${coordinate(point.y, 'y')}` as Hex;
        // The same check `agent/app/src/seal.ts` makes. Failing here is free.
        assertUncompressed(key);
        return key;
    }

    /**
     * The measured code hash, for the receipt's `teeImageDigest`.
     *
     * Flare's fixed simulated value is `0x194844cf...`; seeing it means `SIMULATED_TEE=true` and
     * `MODE=1` are in effect and the attestation proves nothing about the code.
     */
    async codeHash(): Promise<string | undefined> {
        return (await this.info()).machineData?.codeHash;
    }
}
