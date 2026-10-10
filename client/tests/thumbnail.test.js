import assert from "node:assert/strict";
import test from "node:test";
import { thumbnail } from "../src/lib/media/thumbnail.js";

test("cancelling a video thumbnail releases its temporary URL before the decode timeout", async (t) => {
	let revoked = false,
		detached = false;
	const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: () => ({
				addEventListener() {},
				removeAttribute(name) {
					detached = name === "src";
				},
				load() {},
			}),
		},
	});
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, "document", previous);
		else delete globalThis.document;
	});
	t.mock.method(URL, "createObjectURL", () => "blob:video");
	t.mock.method(URL, "revokeObjectURL", (url) => {
		revoked = url === "blob:video";
	});
	const controller = new AbortController();
	const preview = thumbnail(
		new Blob(["video"], { type: "video/webm" }),
		controller.signal,
	);
	controller.abort();
	assert.equal(await preview, null);
	assert.equal(revoked, true);
	assert.equal(detached, true);
});
