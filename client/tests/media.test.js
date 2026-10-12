import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FILE_BYTES } from "../src/lib/api.js";
import { sendUpload } from "../src/lib/media/upload.js";

test("oversized local files are rejected before reading bytes", async () => {
	const file = {
		size: MAX_FILE_BYTES + 1,
		arrayBuffer() {
			assert.fail("must not read");
		},
	};
	await assert.rejects(
		sendUpload({ file, signal: new AbortController().signal }),
		/larger than 32 MB/,
	);
});
