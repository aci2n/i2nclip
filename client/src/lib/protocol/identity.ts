import { b64urlToBytes } from "./bytes.ts";
import { document, string } from "./value.ts";
export interface PrivateKeyDocument {
	v: 1;
	seed: Uint8Array<ArrayBuffer>;
	public_key: Uint8Array<ArrayBuffer>;
}
// The private-key document owns its binary seed and public key.

export function parsePrivateKey(input: unknown) {
	const value = document(input, "Invalid library identity.");
	if (
		value.v !== 1 ||
		!(value.seed instanceof Uint8Array) ||
		value.seed.length !== 32 ||
		!(value.public_key instanceof Uint8Array) ||
		value.public_key.length !== 32
	) {
		throw new Error("Invalid library identity.");
	}
	// loadKey wipes its seed. Never expose a view into the saved document.
	return { seed: value.seed.slice(), publicKey: value.public_key.slice() };
}
export async function generatePrivateKey() {
	const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
	]);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	const privateKey: PrivateKeyDocument = {
		v: 1,
		seed: b64urlToBytes(string(jwk.d)),
		public_key: b64urlToBytes(string(jwk.x)),
	};
	return { privateKey, publicKey: string(jwk.x) };
}
