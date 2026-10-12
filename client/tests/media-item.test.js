import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createMediaItem } from "../src/lib/stores/media-item.js";
import { deferred } from "./helpers.js";
const item = {
	id: "sample",
	metadata: { name: "sample.png", content_type: "image/png", tags: [] },
	thumb: new Uint8Array([1]),
	metaHash: "a",
};
function fixture(t, command) {
	const client = writable({
		connected: true,
		instanceId: "owner",
		session: { epoch: 1 },
		media: { sample: item },
	});
	client.command = command;
	const downloads = [];
	const media = createMediaItem(item, client, {
		download: async (url) => downloads.push(url),
	});
	t.after(media.dispose);
	return { client, media, downloads };
}

test("a pending action disables overlapping actions within a card", async (t) => {
	const job = deferred();
	let calls = 0;
	const f = fixture(t, () => {
		calls++;
		return job.promise;
	});
	const first = f.media.retag(["one"]);
	await f.media.retag(["two"]);
	await f.media.remove();
	assert.equal(calls, 1);
	job.resolve(true);
	await first;
	assert.equal(get(f.media).busy, false);
});

test("failed content retries and disposal releases page-owned URLs", async (t) => {
	const created = [],
		revoked = [];
	let requests = 0;
	t.mock.method(URL, "createObjectURL", () => {
		const url = `blob:${created.length}`;
		created.push(url);
		return url;
	});
	t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
	const f = fixture(t, async () => {
		if (++requests === 1) throw new Error("offline");
		return { blob: new Blob(["bytes"], { type: "image/png" }) };
	});
	await f.media.download();
	assert.match(get(f.media).message, /offline/);
	await f.media.download();
	await f.media.download();
	assert.equal(requests, 2);
	f.media.dispose();
	assert.deepEqual(revoked.sort(), created.sort());
});

test("identity invalidation suppresses URLs and save dialogs from late content", async (t) => {
	const job = deferred();
	const f = fixture(t, () => job.promise);
	const downloading = f.media.download();
	f.client.update((value) => ({ ...value, session: { epoch: 2 } }));
	job.resolve({ blob: new Blob(["late"]) });
	await downloading;
	assert.deepEqual(f.downloads, []);
	assert.equal(get(f.media).url, "");
});

test("shared metadata updates preserve local playback and revoke deleted resources", async (t) => {
	const f = fixture(t, async () => ({
		blob: new Blob(["bytes"], { type: "image/png" }),
	}));
	await f.media.reveal();
	const url = get(f.media).url;
	f.client.update((value) => ({
		...value,
		media: {
			sample: { ...item, metadata: { ...item.metadata, tags: ["new"] } },
		},
	}));
	assert.equal(get(f.media).url, url);
	assert.equal(get(f.media).shown, true);
	assert.deepEqual(get(f.media).metadata.tags, ["new"]);
	f.client.update((value) => ({
		...value,
		media: { sample: { ...item, deleted: true } },
	}));
	assert.equal(get(f.media).url, "");
	assert.equal(get(f.media).preview, "");
});
