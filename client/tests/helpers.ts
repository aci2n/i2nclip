import type { Media } from "../src/lib/api.ts";
import { loadKey } from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { decode } from "../src/lib/protocol/msgpack.ts";
import { bytes, document } from "../src/lib/protocol/value.ts";
export function mediaData(value: Partial<Media> & { id: string }): Media {
	return {
		createdAt: 0,
		bytes: 0,
		metadata: null,
		thumb: null,
		metaHash: "hash",
		...value,
	};
}

export function requestBody(options: RequestInit): Uint8Array<ArrayBuffer> {
	return bytes(options.body);
}
export function requestDocument(options: RequestInit): Record<string, unknown> {
	return document(decode(requestBody(options)));
}

// CryptoKey handles are immutable. Each fixture gets its own mutable byte view.
const sharedKey = await loadKey((await generatePrivateKey()).privateKey);
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
