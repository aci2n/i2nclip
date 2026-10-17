/** Trim, NFC, lowercase. Same rules as `normalize_tag` in Rust. */
export function normalizeTag(tag: string) {
	const text = tag.trim().normalize("NFC").toLowerCase();
	if (!text || [...text].length > 64 || /[\n\r,]/.test(text)) {
		throw new Error("bad tag");
	}
	return text;
}

/** Split user-entered tags while preserving spelling in encrypted metadata. */
export function splitTags(text: unknown): string[] {
	if (Array.isArray(text)) {
		return text.flatMap(splitTags);
	}
	return String(text ?? "")
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

export function parseTagList(text: unknown) {
	return splitTags(text).map(normalizeTag);
}

// Keep the first spelling while comparing tags by their protocol normalization.
export function uniqueTags(text: unknown) {
	const seen = new Set();
	return splitTags(text).filter((tag) => {
		const key = normalizeTag(tag);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
