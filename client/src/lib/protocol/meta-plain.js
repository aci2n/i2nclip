// Extensible metadata and an optional binary preview share one document.
import { decode, encode } from "./msgpack.js";

// Envelope overhead includes map fields, nonce, ciphertext length and GCM tag.
export const MAX_META_PLAINTEXT = 64 * 1024 - 64;

export function encodeMetaPlain(metadata, thumb) {
	const clean = { ...metadata };
	delete clean.thumb;
	return encode({ metadata: clean, thumb: thumb?.length ? thumb : null });
}
export function decodeMetaPlain(bytes) {
	const value = decode(bytes);
	if (
		!value?.metadata ||
		typeof value.metadata !== "object" ||
		Array.isArray(value.metadata) ||
		value.metadata instanceof Uint8Array ||
		(value.thumb !== null && !(value.thumb instanceof Uint8Array))
	) {
		throw new Error("Invalid metadata document.");
	}
	delete value.metadata.thumb;
	return value;
}
