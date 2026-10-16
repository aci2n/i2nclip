// The private-key document owns its binary seed and public key.
import { b64urlToBytes } from "./bytes.js";

export function parsePrivateKey(value) {
	if (
		value?.v !== 1 ||
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
	const privateKey = {
		v: 1,
		seed: b64urlToBytes(jwk.d),
		public_key: b64urlToBytes(jwk.x),
	};
	return { privateKey, publicKey: jwk.x };
}
