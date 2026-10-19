import { bytesToHex, utf8 } from "./bytes.ts";
import {
	type LoadedKey,
	openDescriptorBytes,
	sealDescriptorBytes,
} from "./crypto.ts";
import { decode, encode } from "./msgpack.ts";
import { bytes, document, number } from "./value.ts";

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const CHUNK_TAG_BYTES = 16;
export interface ContentFile {
	id: string;
	size: number;
	chunks: number;
	key: CryptoKey;
}

export function contentShape(size: number) {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error("Invalid plaintext size.");
	}
	const chunks = Math.max(1, Math.ceil(size / CHUNK_BYTES));
	const encryptedBytes = size + chunks * CHUNK_TAG_BYTES;
	if (!Number.isSafeInteger(encryptedBytes)) {
		throw new Error("Content size exceeds the protocol integer range.");
	}
	return { chunks, encryptedBytes };
}

export function chunkLength(
	file: Pick<ContentFile, "size" | "chunks">,
	index: number,
) {
	if (!Number.isSafeInteger(index) || index < 0 || index >= file.chunks) {
		throw new Error("Invalid content chunk index.");
	}
	return Math.min(CHUNK_BYTES, file.size - index * CHUNK_BYTES);
}

async function importContentKey(raw: Uint8Array<ArrayBuffer>) {
	if (raw.length !== 32) {
		throw new Error("Invalid content key.");
	}
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

// Supplied raw content keys support the shared reference vectors.
// Production creates fresh random material for every upload attempt.
export async function sealDescriptor(
	library: LoadedKey,
	id: string,
	size: number,
	raw: Uint8Array<ArrayBuffer>,
) {
	const { chunks } = contentShape(size);
	const key = await importContentKey(raw);
	const plain = encode({
		v: 2,
		key: raw,
		plaintext_bytes: size,
		chunk_bytes: CHUNK_BYTES,
		chunk_count: chunks,
	});
	try {
		const descriptor = await sealDescriptorBytes(
			library.fileKeyMaterial,
			id,
			plain,
		);
		return {
			descriptor,
			content: { id, size, chunks, key } satisfies ContentFile,
		};
	} finally {
		plain.fill(0);
	}
}

export async function createContent(library: LoadedKey, size: number) {
	const id = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
	const raw = crypto.getRandomValues(new Uint8Array(32));
	try {
		return await sealDescriptor(library, id, size, raw);
	} finally {
		raw.fill(0);
	}
}

export async function openDescriptor(
	library: LoadedKey,
	id: string,
	descriptor: Uint8Array<ArrayBuffer>,
): Promise<ContentFile> {
	const plain = await openDescriptorBytes(
		library.fileKeyMaterial,
		id,
		descriptor,
	);
	try {
		const value = document(decode(plain));
		const size = number(value.plaintext_bytes);
		const { chunks } = contentShape(size);
		if (
			value.v !== 2 ||
			value.chunk_bytes !== CHUNK_BYTES ||
			value.chunk_count !== chunks
		) {
			throw new Error("Invalid content descriptor.");
		}
		const raw = bytes(value.key);
		try {
			return { id, size, chunks, key: await importContentKey(raw) };
		} finally {
			raw.fill(0);
		}
	} finally {
		plain.fill(0);
	}
}

function chunkParameters(file: ContentFile, index: number) {
	chunkLength(file, index);
	const iv = new Uint8Array(12);
	new DataView(iv.buffer).setBigUint64(4, BigInt(index));
	return {
		name: "AES-GCM",
		iv,
		additionalData: utf8(
			`i2nclip/v2 chunk\n${file.id}\n${index}\n${file.chunks}\n${file.size}\n`,
		),
	};
}

export async function encryptChunk(
	file: ContentFile,
	index: number,
	plain: Uint8Array<ArrayBuffer>,
) {
	if (plain.length !== chunkLength(file, index)) {
		throw new Error("Invalid plaintext chunk length.");
	}
	return new Uint8Array(
		await crypto.subtle.encrypt(chunkParameters(file, index), file.key, plain),
	);
}

export async function decryptChunk(
	file: ContentFile,
	index: number,
	encrypted: Uint8Array<ArrayBuffer>,
) {
	if (encrypted.length !== chunkLength(file, index) + CHUNK_TAG_BYTES) {
		throw new Error("Invalid encrypted chunk length.");
	}
	return new Uint8Array(
		await crypto.subtle.decrypt(
			chunkParameters(file, index),
			file.key,
			encrypted,
		),
	);
}
