import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { MAX_FILE_BYTES } from "../src/lib/api.js";
import { sendUpload } from "../src/lib/media/upload.js";
import { createMediaItem } from "../src/lib/stores/media-item.js";
import { deferred } from "./helpers.js";

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

test("text previews reuse verified content, bound decoding, save full content and clear on disposal", async (t) => {
	const session = {
		...writable({}),
		epoch: 0,
		signal: new AbortController().signal,
		credentials: () => ({}),
	};
	const content = new TextEncoder().encode(`${"a".repeat(256 * 1024)}tail`);
	let reads = 0;
	let blob;
	const media = createMediaItem(
		{
			id: "code",
			metadata: { name: "source.rs", contentType: "application/octet-stream" },
		},
		session,
		{
			http: {
				getContent: async () => {
					reads++;
					return content;
				},
			},
			urls: {
				createObjectURL: (value) => {
					blob = value;
					return "blob:code";
				},
				revokeObjectURL() {},
			},
			download: async () => {
				assert.equal(blob.size, content.length);
			},
		},
	);
	t.after(media.dispose);
	await media.download();
	assert.equal(get(media).text, null);
	await media.reveal();
	assert.equal(get(media).text.length, 256 * 1024);
	assert.equal(get(media).textTruncated, true);
	await media.reveal();
	assert.equal(reads, 1);
	media.dispose();
	assert.equal(get(media).text, null);
	assert.equal(get(media).textTruncated, false);
});

test("canceled text preparation cannot publish text or clear a subsequent mutation", async (t) => {
	const reading = deferred();
	const entered = deferred();
	const updating = deferred();
	const slice = Blob.prototype.slice;
	t.mock.method(Blob.prototype, "slice", function (...args) {
		const blob = slice.apply(this, args);
		t.mock.method(blob, "arrayBuffer", () => {
			entered.resolve();
			return reading.promise;
		});
		return blob;
	});
	const owner = {
		...writable({}),
		epoch: 0,
		signal: new AbortController().signal,
		credentials: () => ({}),
	};
	const media = createMediaItem(
		{ id: "text", metadata: { name: "note.txt", contentType: "text/plain" } },
		owner,
		{
			http: {
				getContent: async () => new TextEncoder().encode("note"),
				updateMetadata: () => updating.promise,
			},
			urls: { createObjectURL: () => "blob:text", revokeObjectURL() {} },
		},
	);
	t.after(() => {
		reading.resolve(new ArrayBuffer(0));
		updating.resolve({});
		media.dispose();
	});
	const controller = new AbortController();
	const opening = media.reveal(controller.signal);
	await entered.promise;
	controller.abort();
	assert.equal(get(media).busy, false);
	assert.equal(
		get(media).url,
		"blob:text",
		"fully received content stays cached",
	);
	const mutation = media.updateMetadata({ name: "renamed.txt" });
	reading.resolve(new TextEncoder().encode("late text").buffer);
	assert.equal(await opening, false);
	assert.equal(get(media).text, null);
	assert.equal(get(media).busy, true);
	updating.resolve({});
	assert.equal(await mutation, true);
	assert.equal(get(media).metadata.name, "renamed.txt");
});
