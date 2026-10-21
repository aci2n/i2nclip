import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type { MaterializedFile } from "../src/lib/protocol/chain-state.ts";
import type { FileMetadata } from "../src/lib/protocol/file-objects.ts";
import { newFileContent } from "../src/lib/protocol/file-objects.ts";
import {
	createFileMedia,
	FileContentSource,
} from "../src/lib/stores/file-media.ts";
import { deferred } from "./helpers.ts";

const filled = (n: number) => new Uint8Array(32).fill(n);
const file: MaterializedFile = {
	id: filled(1),
	createdSequence: 1,
	manifest: { hash: filled(2), key: filled(3) },
	metadata: { hash: filled(4), key: filled(5) },
	deleted: false,
	purged: false,
};
const metadata: FileMetadata = {
	attributes: { name: "example.txt", content_type: "text/plain" },
	thumbnail: null,
};
async function manifest() {
	const value = await newFileContent(5);
	value.rawKey.fill(0);
	return { content: value.content, hashes: [filled(8)] };
}

test("file previews expose text only after reads complete and release it on close", async (t) => {
	const content = await manifest();
	const plain = new TextEncoder().encode("hello");
	const media = createFileMedia(
		file,
		metadata,
		{
			manifest: async () => content,
			readRange: async () => plain,
			thumbnail: async () => null,
		},
		{
			open: async () => {
				throw new Error("Text does not open a stream");
			},
		},
		new AbortController().signal,
	);
	t.after(media.dispose);
	assert.equal(await media.reveal(), true);
	assert.equal(get(media).text, "hello");
	assert.ok(plain.every((byte) => byte === 0));
	media.close();
	assert.equal(get(media).text, null);
	assert.equal(get(media).ready, false);
});

test("stale thumbnails never create URLs and stale stream leases are disposed", async (t) => {
	const thumbnail = deferred<Uint8Array<ArrayBuffer> | null>();
	const opening = deferred<{
		url: string;
		downloadUrl: string;
		dispose: () => void;
	}>();
	const content = await manifest();
	let urls = 0;
	let disposed = 0;
	const media = createFileMedia(
		file,
		{
			attributes: { name: "image.png", content_type: "image/png" },
			thumbnail: { hash: filled(6), key: filled(7) },
		},
		{
			manifest: async () => content,
			readRange: async () => new Uint8Array(5),
			thumbnail: () => thumbnail.promise,
		},
		{ open: () => opening.promise },
		new AbortController().signal,
		{
			createObjectURL: () => {
				urls++;
				return "blob:test";
			},
			revokeObjectURL: () => {},
		},
	);
	t.after(media.dispose);
	const thumb = media.thumbnail();
	const reveal = media.reveal();
	await new Promise((resolve) => setTimeout(resolve, 0));
	media.dispose();
	const bytes = new Uint8Array([1, 2, 3]);
	thumbnail.resolve(bytes);
	opening.resolve({
		url: "stale",
		downloadUrl: "stale-download",
		dispose: () => {
			disposed++;
		},
	});
	await thumb;
	assert.equal(await reveal, false);
	assert.equal(urls, 0);
	assert.equal(disposed, 1);
	assert.equal(get(media).url, "");
	assert.ok(bytes.every((byte) => byte === 0));
});

test("content sources use authenticated manifest dimensions and propagate stream errors", async () => {
	const content = await manifest();
	let error: unknown;
	const source = new FileContentSource(
		{
			manifest: async () => content,
			thumbnail: async () => null,
			readRange: async () => {
				throw new Error("Authentication failed");
			},
		},
		file,
		{
			attributes: {
				name: "../unsafe.txt",
				size: 9999,
				content_type: "text/plain",
			},
			thumbnail: null,
		},
		content,
		new AbortController().signal,
		(value) => {
			error = value;
		},
	);
	assert.equal(source.size, 5);
	assert.equal(source.name, "unsafe.txt");
	await assert.rejects(
		source.read(0, 5, new AbortController().signal),
		/Authentication failed/,
	);
	assert.ok(error instanceof Error);
});
