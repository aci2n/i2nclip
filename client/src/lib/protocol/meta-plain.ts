import { document, number, string } from "./value.ts";
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

// Bound encrypted metadata independently of content and thumbnail objects.
export const MAX_META_PLAINTEXT = 64 * 1024 - 64;
