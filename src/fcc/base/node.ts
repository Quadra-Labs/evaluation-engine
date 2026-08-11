/**
 * node.ts — the client for Flare's TEE node, the only thing under FCC that holds a key.
 *
 * This is what makes the FCC claim different in kind from the EIP-712 one. There the engine holds
 * a private key, so "the operator cannot read your result" rests on the operator not reading its
 * own process memory. Here the engine holds nothing: the key is generated inside the node at boot,
 * never leaves it, and the extension asks the node to unwrap by POSTing the ciphertext to a
 * loopback port.
 *
 * THREE THINGS THE DOCS GET ONE SENTENCE ON, ALL OF WHICH ARE LOAD-BEARING.
 *
 * BASE64, NOT HEX. Go marshals `[]byte` as base64 in JSON. Every other byte string in this system
 * is 0x-hex, so this endpoint is the exception and sending hex produces an opaque node error.
 *
 * THE PORT COMES FROM THE ENVIRONMENT. Flare's sign-extension guide says SIGN_PORT defaults to
 * 7701; the scaffold's own `config.go` defaults it to 9090. Both are published. Read the variable.
 *
 * THE CIPHERTEXT MUST BE geth-ECIES. Flare documents that callers "ECIES-encrypt using the TEE's
 * public key" and specifies no variant, KDF, cipher, MAC or byte layout anywhere. `ecies-geth` is
 * an INFERENCE from the node being go-ethereum-backed, and it is the single assumption in this
 * system that no published source confirms. Verify it empirically — seal a known plaintext to the
 * key from the proxy's /info and POST it here — before any agent seals anything that costs money.
 * If it is wrong, `quadra-core/src/ecies.ts` is the one file that changes.
 */

interface DecryptResponse {
    readonly decryptedMessage?: string;
}

export class NodeClient {
    private readonly base: string;

    constructor(
        signPort: string | number,
        private readonly timeoutMs = 30_000,
    ) {
        this.base = `http://localhost:${signPort}`;
    }

    get baseUrl(): string {
        return this.base;
    }

    /**
     * Unwrap one ECIES blob.
     *
     * Throws on any failure. Callers that treat "not ours" as an answer rather than an error wrap
     * this in `nodeUnwrap`, which converts a throw to `undefined` — see `src/decrypt.ts`.
     */
    async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(`${this.base}/decrypt`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    encryptedMessage: Buffer.from(ciphertext).toString('base64'),
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                throw new Error(`the TEE node returned ${res.status} from /decrypt`);
            }

            const body = (await res.json()) as DecryptResponse;
            if (typeof body.decryptedMessage !== 'string') {
                throw new Error('the TEE node returned no decryptedMessage');
            }
            return Uint8Array.from(Buffer.from(body.decryptedMessage, 'base64'));
        } finally {
            clearTimeout(timer);
        }
    }
}
