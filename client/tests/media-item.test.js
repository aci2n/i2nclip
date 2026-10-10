import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createMediaItem } from "../src/lib/stores/media-item.js";

import { deferred } from "./helpers.js";

const item = {
	id: "sample",
	metadata: { name: "sample.png", content_type: "image/png", tags: [] },
	tokens: [],
	thumb: new Uint8Array([1]),
};
const credentials = {
	serverUrl: "https://clip.example",
	privateKey: "unused-by-mocked-api",
};

test("a pending tag save prevents another save or delete", async (t) => {
	const job = deferred();
	let updates = 0;
	let deletes = 0;
	const media = createMediaItem(
		item,
		credentials,
		{},
		{
			updateMetadata: () => {
				updates++;
				return job.promise;
			},
			remove: () => {
				deletes++;
			},
		},
	);
	t.after(media.dispose);
	const first = media.retag("one");
	await media.retag("two");
	await media.remove();
	assert.equal(updates, 1);
	assert.equal(deletes, 0);
	job.resolve({ tokens: ["one"] });
	await first;
	assert.deepEqual(get(media).metadata.tags, ["one"]);
	assert.equal(get(media).busy, false);
});

test("a failed content request retries and disposal releases all object URLs", async (t) => {
	const created = [];
	const revoked = [];
	t.mock.method(URL, "createObjectURL", () => {
		const url = `blob:${created.length}`;
		created.push(url);
		return url;
	});
	t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
	let requests = 0;
	const media = createMediaItem(
		item,
		credentials,
		{},
		{
			getContent: async () => {
				if (++requests === 1) throw new Error("temporary");
				return new Uint8Array([1]);
			},
		},
	);
	t.after(media.dispose);
	assert.equal(await media.reveal(), null);
	assert.equal(get(media).message, "temporary");
	assert.equal(await media.reveal(), "blob:1");
	media.dispose();
	assert.deepEqual(revoked, created);
	assert.equal(requests, 2);
});

test("a download that completes after disposal cannot create a URL or open a save dialog", async (t) => {
	const job = deferred();
	let downloads = 0;
	let created = 0;
	t.mock.method(URL, "createObjectURL", () => {
		created++;
		return "blob:preview";
	});
	const media = createMediaItem(
		item,
		credentials,
		{
			download: () => {
				downloads++;
			},
		},
		{ getContent: () => job.promise },
	);
	const download = media.download();
	media.dispose();
	job.resolve(new Uint8Array([1]));
	await download;
	assert.equal(created, 1); // Only the thumbnail, before disposal.
	assert.equal(downloads, 0);
});

test("completed content callbacks cannot restore a progress overlay", async (t) => {
	let progress;
	const media = createMediaItem(
		item,
		credentials,
		{},
		{
			getContent: async (options) => {
				progress = options.onProgress;
				return new Uint8Array([1]);
			},
		},
	);
	t.after(media.dispose);
	await media.reveal();
	progress(99);
	assert.equal(get(media).progress, null);
});
