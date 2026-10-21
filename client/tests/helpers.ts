import { loadSigningKey } from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";

// CryptoKey handles are immutable. Each fixture gets its own mutable byte view.
const sharedKey = await loadSigningKey((await generatePrivateKey()).privateKey);
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
