import { normalizeTag, splitTags } from './crypto.js';

// Keep the first spelling while comparing tags by their protocol normalization.
export function uniqueTags(text) {
  const seen = new Set();
  return splitTags(text).filter((tag) => {
    const key = normalizeTag(tag);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function suggestedTags(text, known) {
  const parts = String(text).split(',');
  const key = (tag) => tag.trim().normalize('NFC').toLowerCase();
  const query = key(parts.pop() || '');
  const selected = new Set(parts.map(key));
  return known.filter((tag) => !selected.has(key(tag)) && key(tag) !== query && key(tag).includes(query)).slice(0, 5);
}
