import assert from "node:assert/strict";
import test from "node:test";
import { uniqueTags } from "../src/lib/protocol/tags.js";

test("tags preserve first spelling and deduplicate case and Unicode equivalents", () => {
	assert.deepEqual(
		uniqueTags([" Vacation, dog ", "vacation, DOG", "Café, Cafe\u0301"]),
		["Vacation", "dog", "Café"],
	);
	assert.throws(() => uniqueTags("a".repeat(65)), /bad tag/);
});
