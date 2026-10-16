import { normalizeTag } from "../protocol/crypto.js";

export function tagSuggestions(tags, draft, excluded) {
	const query = draft.trim().normalize("NFC").toLowerCase();
	if (!query) {
		return [];
	}
	const selected = new Set(excluded.map(normalizeTag));
	// The catalog already supplies alphabetically sorted labels.
	return tags
		.filter((tag) => {
			const normalized = normalizeTag(tag);
			return !selected.has(normalized) && normalized.includes(query);
		})
		.slice(0, 10);
}
