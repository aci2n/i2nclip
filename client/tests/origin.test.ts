import assert from "node:assert/strict";
import test from "node:test";

import vectors from "./origin-vectors.json" with { type: "json" };

test("server origin vectors match browser URL serialization", () => {
	for (const { input, origin } of vectors.accepted) {
		assert.equal(new URL(input.trim()).origin, origin, input);
	}
});
