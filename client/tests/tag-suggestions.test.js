import assert from "node:assert/strict";
import test from "node:test";
import { tagSuggestions } from "../src/lib/ui/tag-suggestions.js";

test("suggestions normalize, exclude selected tags, sort and cap locally", () => {
	assert.deepEqual(
		tagSuggestions(["Café", "Holiday", "summer holiday"], " CAFE\u0301 ", []),
		["Café"],
	);
	assert.deepEqual(
		tagSuggestions(["Work", "Homework", "Worker"], "work", ["WORK"]),
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
