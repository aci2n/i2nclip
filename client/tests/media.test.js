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

test("media reuses full-content Blob URLs for preview and saving until disposal", async (t) => {
	const { get, writable } = await import("svelte/store");
	const { createMediaItem } = await import("../src/lib/stores/media-item.js");
	const controller = new AbortController();
	const session = {
		...writable({}),
		epoch: 0,
		signal: controller.signal,
		credentials: () => ({}),
	};
	const blobs = new Map();
	const revoked = [];
	const saved = [];
	let reads = 0;
	const content = new Uint8Array([1, 2, 3, 4]);
	const media = createMediaItem(
		{ id: "image", metadata: { name: "image.png", contentType: "image/png" } },
		session,
		{
			http: {
				getContent: async () => {
					reads++;
					return content;
				},
			},
			urls: {
				createObjectURL: (blob) => {
					blobs.set("blob:full", blob);
					return "blob:full";
				},
				revokeObjectURL: (url) => revoked.push(url),
			},
			download: (url) => saved.push(url),
		},
	);
	t.after(media.dispose);
	assert.equal(await media.reveal(), "blob:full");
	assert.equal(await media.reveal(), "blob:full");
	assert.equal(await media.download(), true);
	assert.equal(reads, 1);
	assert.deepEqual(
		new Uint8Array(await blobs.get("blob:full").arrayBuffer()),
		content,
	);
	assert.deepEqual(saved, ["blob:full"]);
	assert.equal(get(media).url, "blob:full");
	media.dispose();
	assert.deepEqual(revoked, ["blob:full"]);
	assert.equal(get(media).url, "");
});
