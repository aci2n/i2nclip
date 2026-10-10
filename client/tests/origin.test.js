import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const vectors = JSON.parse(
	readFileSync(new URL("./origin-vectors.json", import.meta.url), "utf8"),
);

test("server origin vectors match browser URL serialization", () => {
	for (const { input, origin } of vectors.accepted) {
		assert.equal(new URL(input.trim()).origin, origin, input);
	}
});
