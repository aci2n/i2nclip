import { bytesToHex } from "./bytes.ts";
import {
	type Bytes,
	fixedBytes,
	MAX_BLOB_BYTES,
	openObject,
	safeInteger,
	sameBytes,
	sealObject,
} from "./chain.ts";
import type { ObjectReference } from "./chain-state.ts";
import {
	CHUNK_BYTES,
	type ContentFile,
	contentShape,
	importContentKey,
} from "./content.ts";
import {
	MAX_META_PLAINTEXT,
	type Metadata,
	parseMetadata,
} from "./meta-plain.ts";
import { decode, encode } from "./msgpack.ts";
import { uniqueTags } from "./tags.ts";

export const MAX_MANIFEST_PLAINTEXT = 4 * 1024 * 1024;
export interface FileManifest {
	readonly content: ContentFile;
	readonly hashes: readonly Bytes[];
}
export interface FileMetadata {
	readonly attributes: Metadata;
	readonly thumbnail: ObjectReference | null;
}
function tuple(value: unknown, length: number): unknown[] {
	if (!Array.isArray(value) || value.length !== length) {
		throw new Error("Invalid encrypted file document.");
	}
	return value;
}
function arrayHeaderLength(count: number) {
	return count < 16 ? 1 : count < 65_536 ? 3 : 5;
}
/** Check size without allocating the potentially enormous chunk-hash array. */
export function manifestSize(size: number) {
	const { chunks } = contentShape(size);
	const base = encode([
		1,
		size,
		CHUNK_BYTES,
		chunks,
		new Uint8Array(32),
		[],
	]).length;
	const length = base - 1 + arrayHeaderLength(chunks) + chunks * 34;
	if (length > MAX_MANIFEST_PLAINTEXT) {
		throw new Error(
			"File requires a manifest larger than the supported limit.",
		);
	}
	return length;
}
export async function newFileContent(size: number) {
	manifestSize(size);
	const { chunks } = contentShape(size);
	const id = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
	const rawKey = crypto.getRandomValues(new Uint8Array(32));
	const key = await importContentKey(rawKey);
	return { content: { id, size, chunks, key } satisfies ContentFile, rawKey };
}
export function encodeManifest(
	size: number,
	rawKey: Bytes,
	hashes: readonly Bytes[],
): Bytes {
	const expected = manifestSize(size);
	const { chunks } = contentShape(size);
	if (hashes.length !== chunks) {
		throw new Error("Manifest chunk count does not match its dimensions.");
	}
	const bytes = encode([
		1,
		size,
		CHUNK_BYTES,
		chunks,
		fixedBytes(rawKey),
		hashes.map((hash) => fixedBytes(hash)),
	]);
	if (bytes.length !== expected) {
		throw new Error("Manifest encoding exceeds its declared dimensions.");
	}
	return bytes;
}
export async function decodeManifest(
	file: Bytes,
	plaintext: Bytes,
): Promise<FileManifest> {
	if (plaintext.length > MAX_MANIFEST_PLAINTEXT) {
		throw new Error("Manifest exceeds the supported limit.");
	}
	const values = tuple(decode(plaintext), 6);
	const size = safeInteger(values[1]);
	const { chunks } = contentShape(size);
	if (
		values[0] !== 1 ||
		values[2] !== CHUNK_BYTES ||
		values[3] !== chunks ||
		!Array.isArray(values[5]) ||
		values[5].length !== chunks
	) {
		throw new Error("Invalid manifest dimensions.");
	}
	const raw = fixedBytes(values[4]);
	try {
		const hashes = values[5].map((hash: unknown) => fixedBytes(hash));
		if (!sameBytes(plaintext, encodeManifest(size, raw, hashes))) {
			throw new Error("Noncanonical file manifest.");
		}
		return {
			content: {
				id: bytesToHex(fixedBytes(file)),
				size,
				chunks,
				key: await importContentKey(raw),
			},
			hashes,
		};
	} finally {
		raw.fill(0);
	}
}
export async function sealManifest(
	library: Bytes,
	file: Bytes,
	size: number,
	rawKey: Bytes,
	hashes: readonly Bytes[],
) {
	const plaintext = encodeManifest(size, rawKey, hashes);
	try {
		return await sealObject(library, file, "manifest", plaintext);
	} finally {
		plaintext.fill(0);
	}
}
export async function openManifest(
	library: Bytes,
	file: Bytes,
	reference: ObjectReference,
	blob: Bytes,
) {
	const plaintext = await openObject(
		library,
		file,
		"manifest",
		reference.hash,
		reference.key,
		blob,
	);
	try {
		return await decodeManifest(file, plaintext);
	} finally {
		plaintext.fill(0);
	}
}
export function encodeFileMetadata(value: FileMetadata) {
	const attributes = parseMetadata(value.attributes);
	delete attributes.thumb;
	attributes.tags = uniqueTags(attributes.tags ?? []);
	const reference = value.thumbnail;
	const bytes = encode([
		1,
		attributes,
		reference ? [fixedBytes(reference.hash), fixedBytes(reference.key)] : null,
	]);
	if (bytes.length > MAX_META_PLAINTEXT) {
		throw new Error("Metadata exceeds the supported limit.");
	}
	return bytes;
}
export function decodeFileMetadata(plaintext: Bytes): FileMetadata {
	if (plaintext.length > MAX_META_PLAINTEXT) {
		throw new Error("Metadata exceeds the supported limit.");
	}
	const values = tuple(decode(plaintext), 3);
	if (values[0] !== 1) {
		throw new Error("Invalid file metadata version.");
	}
	const attributes = parseMetadata(values[1]);
	if ("thumb" in attributes) {
		throw new Error("Thumbnail bytes belong in separate storage.");
	}
	let thumbnail: ObjectReference | null = null;
	if (values[2] !== null) {
		const reference = tuple(values[2], 2);
		thumbnail = {
			hash: fixedBytes(reference[0]),
			key: fixedBytes(reference[1]),
		};
	}
	const value = { attributes, thumbnail };
	// Metadata is extensible, but the surrounding fixed frame and normalized tags are canonical.
	if (!sameBytes(plaintext, encodeFileMetadata(value))) {
		throw new Error("Noncanonical file metadata.");
	}
	return value;
}
export async function sealFileMetadata(
	library: Bytes,
	file: Bytes,
	value: FileMetadata,
) {
	const plaintext = encodeFileMetadata(value);
	try {
		return await sealObject(library, file, "metadata", plaintext);
	} finally {
		plaintext.fill(0);
	}
}
export async function openFileMetadata(
	library: Bytes,
	file: Bytes,
	reference: ObjectReference,
	blob: Bytes,
) {
	const plaintext = await openObject(
		library,
		file,
		"metadata",
		reference.hash,
		reference.key,
		blob,
	);
	try {
		return structuredClone(decodeFileMetadata(plaintext));
	} finally {
		plaintext.fill(0);
	}
}
export async function sealThumbnail(
	library: Bytes,
	file: Bytes,
	plaintext: Bytes,
) {
	// Use the actual envelope size, including binary framing and the GCM tag.
	if (plaintext.length > MAX_BLOB_BYTES - 64) {
		throw new Error("Thumbnail exceeds the supported limit.");
	}
	return sealObject(library, file, "thumbnail", plaintext);
}
