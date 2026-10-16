import { normalizeTag } from "../protocol/crypto.js";

export function tagSuggestions(tags, draft, excluded) {
	const query = draft.trim().normalize("NFC").toLowerCase();
	if (!query) {
		return [];
	}
	const selected = new Set(excluded.map(normalizeTag));
	return tags
		.filter(
			(tag) =>
				!selected.has(normalizeTag(tag)) && normalizeTag(tag).includes(query),
		)
		.sort((a, b) => a.localeCompare(b))
		.slice(0, 10);
}
