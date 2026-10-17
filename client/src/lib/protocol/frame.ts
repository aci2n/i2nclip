import { encode } from "./msgpack.ts";
import type { SealedTag } from "./tag-labels.ts";
// Named maps match src/frame.rs; signatures cover these exact encoded bytes.

export function encodeUpload({
	meta,
	content,
	tags,
}: {
	meta: Uint8Array;
	content: Uint8Array;
	tags: SealedTag[];
}) {
	return encode({ meta, content, tags });
}

export function encodeMeta({
	prevMetaHash,
	meta,
	tags,
}: {
	prevMetaHash: Uint8Array;
	meta: Uint8Array;
	tags: SealedTag[];
}) {
	if (!(prevMetaHash instanceof Uint8Array) || prevMetaHash.length !== 32) {
		throw new TypeError("previous metadata hash must be 32 bytes");
	}
	return encode({ prev_meta_hash: prevMetaHash, meta, tags });
}
