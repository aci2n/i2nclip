// Named maps match src/frame.rs; signatures cover these exact encoded bytes.
import { encode } from "./msgpack.js";

export function encodeUpload({ meta, content, tags }) {
	return encode({ meta, content, tags });
}

export function encodeMeta({ prevMetaHash, meta, tags }) {
	if (!(prevMetaHash instanceof Uint8Array) || prevMetaHash.length !== 32) {
		throw new TypeError("previous metadata hash must be 32 bytes");
	}
	return encode({ prev_meta_hash: prevMetaHash, meta, tags });
}
