import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { MAX_FILE_BYTES } from "../src/lib/api.js";
import { sendUpload } from "../src/lib/media/upload.js";
import {
	bodyHash,
	contentAad,
	decrypt,
	loadKey,
	metaAad,
} from "../src/lib/protocol/crypto.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { decodeMetaPlain } from "../src/lib/protocol/meta-plain.js";
import { decode } from "../src/lib/protocol/msgpack.js";
import { createMediaItem } from "../src/lib/stores/media-item.js";
import { deferred } from "./helpers.js";
import { documentResponse } from "./msgpack-response.js";

for (const cancel of [false, true]) {
	test(`audio uploads read once and ${cancel ? "release artwork on cancellation" : "preserve content and artwork"}`, async (t) => {
		const art = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
		// FLAC picture block: front cover, empty MIME/description, image bytes.
		const bytes = new Uint8Array(8 + 32 + art.length);
		bytes.set([0x66, 0x4c, 0x61, 0x43, 0x86, 0, 0, 32 + art.length]);
		const picture = new DataView(bytes.buffer, 8);
		picture.setUint32(0, 3);
		picture.setUint32(28, art.length);
		bytes.set(art, 40);
		const file = new File([bytes], "Cover.flac", { type: "audio/flac" });
		const read = t.mock.method(file, "arrayBuffer", file.arrayBuffer);
		const controller = new AbortController();
		let closed = false;
		let artworkRead = false;
		const thumb = new Uint8Array([1, 2, 3]);
		const globals = {
			createImageBitmap: async (blob) => {
				assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), art);
				artworkRead = true;
				if (cancel) {
					controller.abort();
				}
				return {
					width: 16,
					height: 8,
					close: () => {
						closed = true;
					},
				};
			},
			OffscreenCanvas: class {
				getContext() {
					return { drawImage() {} };
				}
				async convertToBlob() {
					return new Blob([thumb]);
				}
			},
		};
		for (const [name, value] of Object.entries(globals)) {
			const previous = Object.getOwnPropertyDescriptor(globalThis, name);
			t.after(() => {
				if (previous) {
					Object.defineProperty(globalThis, name, previous);
				} else {
					delete globalThis[name];
				}
			});
			Object.defineProperty(globalThis, name, { configurable: true, value });
		}
		const { privateKey } = await generatePrivateKey();
		const key = await loadKey(privateKey);
		const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
			const frame = decode(options.body);
			const id = await bodyHash(frame.content);
			assert.deepEqual(await decrypt(key, contentAad(), frame.content), bytes);
			const preview = decodeMetaPlain(
				await decrypt(key, metaAad(id), frame.meta),
			);
			assert.deepEqual(preview.thumb, thumb);
			assert.deepEqual(preview.metadata.image, { width: 16, height: 8 });
			return documentResponse({ id }, { status: 201 });
		});
		const upload = sendUpload({
			file,
			credentials: { serverUrl: "https://clip.example", key },
			signal: controller.signal,
		});
		if (cancel) {
			await assert.rejects(upload, { name: "AbortError" });
		} else {
			assert.equal((await upload).metadata.size, bytes.length);
		}
		assert.equal(read.mock.callCount(), 1);
		assert.equal(fetch.mock.callCount(), cancel ? 0 : 1);
		assert.equal(artworkRead, true);
		assert.equal(closed, true);
	});
}

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
		{ id: "image", metadata: { name: "image.png", content_type: "image/png" } },
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
			metadata: { name: "source.rs", content_type: "application/octet-stream" },
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
		{ id: "text", metadata: { name: "note.txt", content_type: "text/plain" } },
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
