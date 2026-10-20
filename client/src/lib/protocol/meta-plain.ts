import { decode, encode } from "./msgpack.ts";
import { bytes as binary, document, number, string } from "./value.ts";
export interface Metadata {
	[field: string]: unknown;
	name?: string;
	content_type?: string;
	size?: number;
	tags?: string[];
	image?: { width: number; height: number };
	source_url?: string;
	source_title?: string;
}
export function parseMetadata(input: unknown): Metadata {
	const value = document(input);
	const result: Metadata = { ...value };
	for (const key of [
		"name",
		"content_type",
		"source_url",
		"source_title",
	] as const) {
		if (value[key] !== undefined) {
			result[key] = string(value[key]);
		}
	}
	if (value.size !== undefined) {
		result.size = number(value.size);
	}
	if (value.tags !== undefined) {
		if (!Array.isArray(value.tags)) {
			throw new Error("Invalid metadata tags.");
		}
		result.tags = value.tags.map(string);
	}
	if (value.image !== undefined) {
		const image = document(value.image);
		result.image = { width: number(image.width), height: number(image.height) };
	}
	return result;
}

// Extensible metadata and an optional binary preview share one document.

// Envelope overhead includes map fields, nonce, ciphertext length and GCM tag.
export const MAX_META_PLAINTEXT = 64 * 1024 - 64;

export function encodeMetaPlain(metadata: Metadata, thumb?: Uint8Array | null) {
	const clean = { ...metadata };
	delete clean.thumb;
	return encode({ metadata: clean, thumb: thumb?.length ? thumb : null });
}
export function decodeMetaPlain(bytes: Uint8Array) {
	const value = document(decode(bytes));
	if (
		!value.metadata ||
		typeof value.metadata !== "object" ||
		Array.isArray(value.metadata) ||
		value.metadata instanceof Uint8Array ||
		(value.thumb !== null && !(value.thumb instanceof Uint8Array))
	) {
		throw new Error("Invalid metadata document.");
	}
	const metadata = parseMetadata(value.metadata);
	delete metadata.thumb;
	return { metadata, thumb: value.thumb === null ? null : binary(value.thumb) };
}
