import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import * as api from "../src/lib/api.ts";
import { createMediaItem } from "../src/lib/stores/media-item.ts";
import { deferred, mediaData, testKey, tick } from "./helpers.ts";
import { streamFixture } from "./stream-fixture.ts";

function fixture(
	t: test.TestContext,
	metadata = { name: "image.png", content_type: "image/png", size: 3 },
	http: Partial<api.MediaApi> = {},
) {
	const lifetime = new AbortController();
	const streams = streamFixture();
	const saved: string[] = [];
	const media = createMediaItem(
		mediaData({ id: "a".repeat(64), metadata }),
		{
			signal: lifetime.signal,
			serverUrl: "https://clip.example",
			key: testKey(),
		},
		{
			streams: streams.streams,
			http: { ...api, ...http },
			download: (url) => {
				saved.push(url);
			},
		},
	);
	t.after(() => {
		streams.finish.resolve();
		media.dispose();
		lifetime.abort();
	});
	return { media, lifetime, ...streams, saved };
}

test("previews own stream leases while downloads survive view disposal", async (t) => {
	const f = fixture(t);
	assert.equal(await f.media.reveal(), true);
	assert.equal(get(f.media).url, "/__content/preview");
	assert.equal(await f.media.reveal(), true);
	assert.equal(f.previews.length, 1);
	const downloading = f.media.download();
	await tick();
	assert.equal(f.downloads.length, 1);
	assert.deepEqual(f.saved, ["/__content/download"]);
	f.media.dispose();
	assert.equal(f.previews[0].disposed, true);
	assert.equal(f.lifetime.signal.aborted, false);
	f.finish.resolve();
	assert.equal(await downloading, true);
});

test("text previews request only the bounded prefix and never allocate object URLs", async (t) => {
	const requests: api.ContentRequest[] = [];
	const f = fixture(
		t,
		{
			name: "source.rs",
			content_type: "application/octet-stream",
			size: 2 ** 30,
		},
		{
			readContentRange: async (request) => {
				requests.push(request);
				return new Uint8Array(request.end).fill(97);
			},
		},
	);
	assert.equal(await f.media.reveal(), true);
	assert.equal(requests[0].start, 0);
	assert.equal(requests[0].end, 256 * 1024);
	assert.equal(get(f.media).text?.length, 256 * 1024);
	assert.equal(get(f.media).textTruncated, true);
	assert.equal(get(f.media).url, "");
	assert.equal(f.previews.length, 0);
	await f.media.reveal();
	assert.equal(requests.length, 1);
	f.media.dispose();
	assert.equal(get(f.media).text, null);
});

test("cancellation cannot publish stale text or clear a subsequent mutation", async (t) => {
	const reading = deferred<Uint8Array<ArrayBuffer>>();
	const updating = deferred<api.MetadataResult>();
	const f = fixture(
		t,
		{ name: "note.txt", content_type: "text/plain", size: 4 },
		{
			readContentRange: () => reading.promise,
			updateMetadata: () => updating.promise,
		},
	);
	const caller = new AbortController();
	const opening = f.media.reveal(caller.signal);
	caller.abort();
	assert.equal(get(f.media).busy, false);
	const mutation = f.media.updateMetadata({ name: "renamed.txt" });
	reading.resolve(new TextEncoder().encode("late"));
	assert.equal(await opening, false);
	assert.equal(get(f.media).text, null);
	assert.equal(get(f.media).busy, true);
	updating.resolve({ conflict: false, metaHash: "saved" });
	assert.equal(await mutation, true);
});

test("closing a preview cancels its lease and reopening creates a new lease", async (t) => {
	const f = fixture(t);
	const caller = new AbortController();
	await f.media.reveal(caller.signal);
	caller.abort();
	assert.equal(f.previews[0].disposed, true);
	assert.equal(get(f.media).ready, false);
	await f.media.reveal();
	assert.equal(f.previews.length, 2);
});

test("ordinary files need no content reads, deletion invalidates all session streams", async (t) => {
	const f = fixture(
		t,
		{
			name: "file.bin",
			content_type: "application/octet-stream",
			size: 2 ** 30,
		},
		{
			readContentRange: async () => assert.fail("no preview read"),
			remove: async () => {},
		},
	);
	assert.equal(await f.media.reveal(), true);
	assert.equal(get(f.media).ready, true);
	assert.equal(f.previews.length, 0);
	assert.equal(await f.media.remove(), true);
	assert.deepEqual(f.invalidated, ["a".repeat(64)]);
	assert.equal(get(f.media).deleted, true);
});

test("stream read failures remain local to the current preview and permit retry", async (t) => {
	const f = fixture(t, undefined, {
		readContentRange: async () => {
			throw new Error("Transfer unavailable");
		},
	});
	await f.media.reveal();
	await assert.rejects(
		f.previews[0].source.read(0, 3, new AbortController().signal),
		/Transfer unavailable/,
	);
	assert.equal(get(f.media).message, "Transfer unavailable");
	assert.equal(get(f.media).ready, false);
	assert.equal(await f.media.reveal(), true);
	assert.equal(f.previews[0].disposed, true);
	assert.equal(get(f.media).error, false);
});
