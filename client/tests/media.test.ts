import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type { MetadataResult } from "../src/lib/api.ts";
import * as api from "../src/lib/api.ts";
import { DEFAULT_MAX_FILE_PLAINTEXT_BYTES } from "../src/lib/api.ts";
import { defaultUploadOptions } from "../src/lib/media/options.ts";
import { sendUpload } from "../src/lib/media/upload.ts";
import {
	bodyHash,
	contentAad,
	decrypt,
	loadKey,
	metaAad,
} from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { decodeMetaPlain } from "../src/lib/protocol/meta-plain.ts";
import { bytes as binary } from "../src/lib/protocol/value.ts";
import { createMediaItem } from "../src/lib/stores/media-item.ts";
import { assertPresent } from "./assert.ts";
import { deferred, mediaData, requestDocument, testKey } from "./helpers.ts";
import { documentResponse } from "./msgpack-response.ts";

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
			createImageBitmap: async (blob: Blob) => {
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
					return { canvas: this, drawImage() {} };
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
					Reflect.deleteProperty(globalThis, name);
				}
			});
			Object.defineProperty(globalThis, name, { configurable: true, value });
		}
		const { privateKey } = await generatePrivateKey();
		const key = await loadKey(privateKey);
		const fetch = t.mock.method(
			globalThis,
			"fetch",
			async (_url: string | URL | Request, options: RequestInit = {}) => {
				const frame = requestDocument(options);
				const id = await bodyHash(binary(frame.content));
				assert.deepEqual(
					await decrypt(key, contentAad(), binary(frame.content)),
					bytes,
				);
				const preview = decodeMetaPlain(
					await decrypt(key, metaAad(id), binary(frame.meta)),
				);
				assert.deepEqual(preview.thumb, thumb);
				assert.deepEqual(preview.metadata.image, { width: 16, height: 8 });
				return documentResponse({ id, created_at: 1 }, { status: 201 });
			},
		);
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
	const file = new File([], "oversized");
	Object.defineProperty(file, "size", {
		value: DEFAULT_MAX_FILE_PLAINTEXT_BYTES + 1,
	});
	file.arrayBuffer = async () => assert.fail("must not read");
	await assert.rejects(
		sendUpload({
			file,
			credentials: { serverUrl: "https://clip.example", key: testKey() },
			signal: new AbortController().signal,
		}),
		/larger than 32 MB/,
	);
});
test("media reuses full-content Blob URLs for preview and saving until disposal", async (t) => {
	const controller = new AbortController();
	const session = {
		signal: controller.signal,
		serverUrl: "https://clip.example",
		key: testKey(),
	};
	const blobs = new Map();
	const revoked: Array<string> = [];
	const saved: Array<string> = [];
	let reads = 0;
	let progress: api.Progress | undefined;
	const content = new Uint8Array([1, 2, 3, 4]);
	const media = createMediaItem(
		mediaData({
			id: "image",
			metadata: { name: "image.png", content_type: "image/png" },
		}),
		session,
		{
			http: {
				...api,
				getContent: async ({ onProgress }) => {
					progress = onProgress;
					reads++;
					return content;
				},
			},
			urls: {
				createObjectURL: (blob: Blob | MediaSource) => {
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
	assertPresent(progress)(99);
	assert.equal(get(media).progress, null);
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
		signal: new AbortController().signal,
		serverUrl: "https://clip.example",
		key: testKey(),
	};
	const content = new TextEncoder().encode(`${"a".repeat(256 * 1024)}tail`);
	let reads = 0;
	let blob: Blob | MediaSource;
	const media = createMediaItem(
		mediaData({
			id: "code",
			metadata: { name: "source.rs", content_type: "application/octet-stream" },
		}),
		session,
		{
			http: {
				...api,
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
				assert(blob instanceof Blob);
				assert.equal(blob.size, content.length);
			},
		},
	);
	t.after(media.dispose);
	await media.download();
	assert.equal(get(media).text, null);
	await media.reveal();
	assert.equal(assertPresent(get(media).text).length, 256 * 1024);
	assert.equal(get(media).textTruncated, true);
	await media.reveal();
	assert.equal(reads, 1);
	media.dispose();
	assert.equal(get(media).text, null);
	assert.equal(get(media).textTruncated, false);
});
test("canceled text preparation cannot publish text or clear a subsequent mutation", async (t) => {
	const reading = deferred<ArrayBuffer>();
	const entered = deferred();
	const updating = deferred<MetadataResult>();
	const slice = Blob.prototype.slice;
	t.mock.method(
		Blob.prototype,
		"slice",
		function (this: Blob, ...args: Parameters<Blob["slice"]>) {
			const blob = slice.apply(this, args);
			t.mock.method(blob, "arrayBuffer", () => {
				entered.resolve();
				return reading.promise;
			});
			return blob;
		},
	);
	const owner = {
		signal: new AbortController().signal,
		serverUrl: "https://clip.example",
		key: testKey(),
	};
	const media = createMediaItem(
		mediaData({
			id: "text",
			metadata: { name: "note.txt", content_type: "text/plain" },
		}),
		owner,
		{
			http: {
				...api,
				getContent: async () => new TextEncoder().encode("note"),
				updateMetadata: () => updating.promise,
			},
			urls: { createObjectURL: () => "blob:text", revokeObjectURL() {} },
		},
	);
	t.after(() => {
		reading.resolve(new ArrayBuffer(0));
		updating.resolve({ conflict: false, metaHash: "saved" });
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
	updating.resolve({ conflict: false, metaHash: "saved" });
	assert.equal(await mutation, true);
	assert.equal(assertPresent(get(media).metadata).name, "renamed.txt");
});

for (const limit of [0, 2]) {
	test(`configured file limit ${limit} rejects before reading`, async () => {
		const file = new File([new Uint8Array(3)], "limit.bin");
		file.arrayBuffer = async () => assert.fail("must not read");
		await assert.rejects(
			sendUpload({
				file,
				maxFilePlaintextBytes: limit,
				credentials: { serverUrl: "https://clip.example", key: testKey() },
				signal: new AbortController().signal,
			}),
			limit === 0 ? /Uploads are disabled/ : /larger than 2 bytes/,
		);
	});
}

test("a configured larger limit reaches the read for files above 32 MiB", async () => {
	const file = new File([], "large.bin");
	Object.defineProperty(file, "size", {
		value: DEFAULT_MAX_FILE_PLAINTEXT_BYTES + 1,
	});
	file.arrayBuffer = async () => {
		throw new Error("reached read");
	};
	await assert.rejects(
		sendUpload({
			file,
			options: {
				...defaultUploadOptions(),
				image: {
					enabled: false,
					format: "webp",
					quality: 85,
					maxWidth: null,
					maxHeight: null,
				},
			},
			maxFilePlaintextBytes: 64 * 1024 * 1024,
			credentials: { serverUrl: "https://clip.example", key: testKey() },
			signal: new AbortController().signal,
		}),
		/reached read/,
	);
});

test("prepared bytes are rechecked before encryption or a network upload", async (t) => {
	const file = new File([new Uint8Array(3)], "prepared.bin");
	Object.defineProperty(file, "size", { value: 1 });
	const fetch = t.mock.method(globalThis, "fetch", async () =>
		assert.fail("must not upload"),
	);
	await assert.rejects(
		sendUpload({
			file,
			options: {
				...defaultUploadOptions(),
				image: {
					enabled: false,
					format: "webp",
					quality: 85,
					maxWidth: null,
					maxHeight: null,
				},
			},
			maxFilePlaintextBytes: 2,
			credentials: { serverUrl: "https://clip.example", key: testKey() },
			signal: new AbortController().signal,
		}),
		/larger than 2 bytes/,
	);
	assert.equal(fetch.mock.callCount(), 0);
});
