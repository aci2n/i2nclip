// Plaintext inside the encrypted metadata blob (before AES-GCM).
//
//   uint32be  json length
//   bytes     UTF-8 JSON (name, tags, content_type, size, image — no thumb)
//   uint32be  thumb length (0 = none)
//   bytes     WebP preview bytes

import { chunk, concat, utf8 } from "./bytes.js";

/** Room left for the 1-byte version, 12-byte nonce, and 16-byte GCM tag. */
export const MAX_META_PLAINTEXT = 64 * 1024 - 29;

// Only schema-owned keys change case; arbitrary extension keys stay intact.
const fields = {
	content_type: "contentType",
	source_url: "sourceUrl",
	source_title: "sourceTitle",
};

export function encodeMetaPlain(metadata, thumb) {
	const clean = { ...metadata };
	delete clean.thumb;
	for (const [stored, runtime] of Object.entries(fields)) {
		if (Object.hasOwn(clean, runtime)) {
			clean[stored] = clean[runtime];
			delete clean[runtime];
		}
	}
	const json = utf8(JSON.stringify(clean));
	const preview = thumb?.length ? thumb : new Uint8Array();
	return concat([chunk(json), chunk(preview)]);
}

export function decodeMetaPlain(bytes) {
	let o = 0;
	const json = readChunk(bytes, o);
	o += 4 + json.length;
	const thumb = readChunk(bytes, o);
	o += 4 + thumb.length;
	if (o !== bytes.length) {
		throw new Error("trailing metadata");
	}
	const metadata = JSON.parse(new TextDecoder().decode(json));
	delete metadata.thumb;
	for (const [stored, runtime] of Object.entries(fields)) {
		if (Object.hasOwn(metadata, stored)) {
			metadata[runtime] = metadata[stored];
			delete metadata[stored];
		}
	}
	return {
		metadata,
		thumb: thumb.length ? thumb : null,
	};
}

function readChunk(bytes, offset) {
	if (bytes.length - offset < 4) {
		throw new Error("truncated metadata");
	}
	const len = new DataView(
		bytes.buffer,
		bytes.byteOffset + offset,
		4,
	).getUint32(0);
	offset += 4;
	if (bytes.length - offset < len) {
		throw new Error("truncated metadata");
	}
	return bytes.subarray(offset, offset + len);
}
