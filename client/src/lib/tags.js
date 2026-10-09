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
