/**
 * encoding.ts — the byte conversions the FCC wire format uses.
 *
 * Ported from Flare's `fce-extension-scaffold`. This is the wire contract, not our design: the
 * other end is Go, and these functions exist to match Go's conventions exactly rather than
 * JavaScript's.
 *
 * The two that bite:
 *
 *   `hexToBytes('0x')` is the EMPTY array, not a failure. Go's `hexutil.Bytes` marshals an empty
 *   slice as the string "0x", so a handler that receives "0x" has received an empty message, and
 *   treating that as a parse error rejects every legitimately-empty instruction.
 *
 *   `stringToBytes32Hex` right-zero-pads. Solidity's `bytes32("EVALUATION")` is the UTF-8 bytes
 *   followed by zeros, and the comparison at the other end is on the full 32 bytes. Left-padding
 *   (the natural choice for a number) produces a constant that never matches, and the failure is
 *   silent: the instruction is accepted on chain and never delivered to the extension.
 */

/** Go `hexutil.Bytes` semantics: optional 0x, and "0x" or "" means empty. */
export function hexToBytes(hex: string | null | undefined): Uint8Array {
    if (!hex) return new Uint8Array(0);
    const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
    if (body.length === 0) return new Uint8Array(0);
    if (body.length % 2 !== 0) throw new Error(`hex string has an odd length: ${body.length}`);
    if (!/^[0-9a-fA-F]*$/.test(body)) throw new Error('hex string contains a non-hex character');
    return Uint8Array.from(Buffer.from(body, 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
    return `0x${Buffer.from(bytes).toString('hex')}`;
}

/** UTF-8, right-zero-padded to 32 bytes. The Solidity `bytes32("...")` literal. */
export function stringToBytes32Hex(value: string): string {
    const utf8 = Buffer.from(value, 'utf8');
    if (utf8.length > 32) throw new Error(`"${value}" does not fit in bytes32`);
    const padded = Buffer.alloc(32);
    utf8.copy(padded, 0);
    return `0x${padded.toString('hex')}`;
}

/**
 * The inverse, for LOG LINES ONLY.
 *
 * Never dispatch on this. Two different byte strings can render to the same readable text once
 * trailing zeros are stripped, and a round trip through it is not guaranteed to be the identity.
 * Dispatch compares the 32 bytes.
 */
export function bytes32HexToString(hex: string): string {
    const bytes = hexToBytes(hex);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    return Buffer.from(bytes.subarray(0, end)).toString('utf8');
}
