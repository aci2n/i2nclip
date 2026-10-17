import assert from "node:assert/strict";
import test from "node:test";
import { tagSuggestions } from "../src/lib/ui/tag-suggestions.ts";

test("suggestions normalize, exclude selected tags and preserve catalog order", () => {
	assert.deepEqual(
		tagSuggestions(["Café", "Holiday", "summer holiday"], " CAFE\u0301 ", []),
		["Café"],
	);
	assert.deepEqual(
		tagSuggestions(["Homework", "Work", "Worker"], "work", ["WORK"]),
		["Homework", "Worker"],
	);
	assert.deepEqual(tagSuggestions(["Work"], "", []), []);
	assert.equal(
		tagSuggestions(
			Array.from({ length: 20 }, (_, i) => `tag${i}`),
			"tag",
			[],
		).length,
		10,
	);
});
