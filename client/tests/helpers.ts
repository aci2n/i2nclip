import type { SigningKey } from "../src/lib/protocol/auth.ts";
import {
	bytesToB64url,
	concat,
	hexToBytes,
} from "../src/lib/protocol/bytes.ts";
export async function loadSigningKey(document: unknown): Promise<SigningKey> {
	const { seed, public_key: publicKey } = document as {
		seed: Uint8Array<ArrayBuffer>;
		public_key: Uint8Array<ArrayBuffer>;
	};
	const privateCryptoKey = await crypto.subtle.importKey(
		"pkcs8",
		concat([hexToBytes("302e020100300506032b657004220420"), seed]),
		"Ed25519",
		false,
		["sign"],
	);
	return {
		privateCryptoKey,
		publicKey: publicKey.slice(),
		registrationKey: bytesToB64url(publicKey),
	};
}
const pair = await crypto.subtle.generateKey("Ed25519", false, [
	"sign",
	"verify",
]);
const publicKey = new Uint8Array(
	await crypto.subtle.exportKey("raw", pair.publicKey),
);
const sharedKey = {
	privateCryptoKey: pair.privateKey,
	publicKey,
	registrationKey: bytesToB64url(publicKey),
};
// CryptoKey handles are immutable. Each fixture gets its own mutable byte view.

export function testKey() {
	return Object.freeze({
		...sharedKey,
		publicKey: sharedKey.publicKey.slice(),
	});
}

export function deferred<T = void>() {
	return Promise.withResolvers<T>();
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));
