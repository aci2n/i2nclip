import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type { ContentRequest, Media, ViewerApi } from "../src/lib/api.ts";
import { createMediaViewer } from "../src/lib/stores/media-viewer.ts";
import { assertPresent } from "./assert.ts";
import { deferred, mediaData, testKey, tick } from "./helpers.ts";

const id = "a".repeat(64);
function fixture(t: test.TestContext, http: Partial<ViewerApi> = {}) {
	const lifetime = new AbortController();
	const created: Blob[] = [];
	const revoked: string[] = [];
	const downloads: { url: string; name: string }[] = [];
	const viewer = createMediaViewer(
		id,
		{
			serverUrl: "https://clip.example",
			key: testKey(),
			signal: lifetime.signal,
		},
		{
			http: {
				getMedia: async () =>
					mediaData({
						id,
						metadata: { name: "Portrait.png", content_type: "image/png" },
					}),
				getContent: async () => new Uint8Array([1, 2, 3]),
				...http,
			},
			urls: {
				createObjectURL(blob) {
					created.push(blob as Blob);
					return `blob:${created.length}`;
				},
				revokeObjectURL: (url) => revoked.push(url),
			},
			download: (url, name) => {
				downloads.push({ url, name });
			},
		},
	);
	t.after(viewer.dispose);
	t.after(() => lifetime.abort());
	return { viewer, lifetime, created, revoked, downloads };
}
function settled(
	t: test.TestContext,
	viewer: ReturnType<typeof createMediaViewer>,
) {
	const done = deferred();
	const timer = setTimeout(
		() => done.reject(new Error("Viewer did not settle")),
		3000,
	);
	const unsubscribe = viewer.subscribe((value) => {
		if (!value.loading) {
			done.resolve();
		}
	});
	const cleanup = () => {
		clearTimeout(timer);
		unsubscribe();
	};
	t.after(cleanup);
	return done.promise.finally(cleanup);
}
test("viewer reads one item, publishes progress, prepares text and reuses content for explicit downloads", async (t) => {
	const content = deferred<Uint8Array<ArrayBuffer>>();
	let request: ContentRequest | undefined;
	let reads = 0;
	const f = fixture(t, {
		getMedia: async () =>
			mediaData({
				id,
				metadata: { name: "note.html", content_type: "text/html" },
			}),
		getContent: (args) => {
			reads++;
			request = args;
			return content.promise;
		},
	});
	await tick();
	assert.equal(get(f.viewer).loading, true);
	assertPresent(request).onProgress?.(37);
	assert.equal(get(f.viewer).media?.progress, 37);
	assert.equal(await f.viewer.retry(), false);
	content.resolve(new TextEncoder().encode("<script>unsafe()</script>"));
	await settled(t, f.viewer);
	assert.equal(get(f.viewer).media?.text, "<script>unsafe()</script>");
	assert.equal(f.created.length, 1);
	assert.equal(f.downloads.length, 0);
	assert.equal(await f.viewer.download(), true);
	assert.equal(await f.viewer.download(), true);
	assert.equal(reads, 1);
	assert.deepEqual(f.downloads, [
		{ url: "blob:1", name: "note.html" },
		{ url: "blob:1", name: "note.html" },
	]);
	f.viewer.dispose();
	assert.deepEqual(f.revoked, ["blob:1"]);
});
test("metadata failures and missing files can retry without starting content prematurely", async (t) => {
	let missing = true;
	let reads = 0;
	const f = fixture(t, {
		getMedia: async () => {
			if (missing) {
				throw Object.assign(new Error("Not Found"), { status: 404 });
			}
			return mediaData({
				id,
				metadata: { name: "file", content_type: "application/octet-stream" },
			});
		},
		getContent: async () => {
			reads++;
			return new Uint8Array([1]);
		},
	});
	await settled(t, f.viewer);
	assert.equal(get(f.viewer).error, "File not found in this library.");
	assert.equal(reads, 0);
	missing = false;
	assert.equal(await f.viewer.retry(), true);
	assert.equal(reads, 1);
	assert.equal(get(f.viewer).error, "");
});
test("content failures keep metadata for retry and leave other content untouched", async (t) => {
	let fail = true;
	let metadataReads = 0;
	const f = fixture(t, {
		getMedia: async () => {
			metadataReads++;
			return mediaData({
				id,
				metadata: { name: "image.png", content_type: "image/png" },
			});
		},
		getContent: async () => {
			if (fail) {
				throw new Error("offline");
			}
			return new Uint8Array([1]);
		},
	});
	await settled(t, f.viewer);
	assert.equal(get(f.viewer).media?.message, "offline");
	fail = false;
	assert.equal(await f.viewer.retry(), true);
	assert.equal(metadataReads, 1);
	assert.equal(f.created.length, 1);
});
for (const end of ["dispose", "identity"] as const) {
	test(`${end} cancels metadata and ignores its late result`, async (t) => {
		const metadata = deferred<Media>();
		let signal: AbortSignal | undefined;
		let reads = 0;
		const f = fixture(t, {
			getMedia: (args) => {
				signal = args.signal;
				return metadata.promise;
			},
			getContent: async () => {
				reads++;
				return new Uint8Array([1]);
			},
		});
		if (end === "dispose") {
			f.viewer.dispose();
		} else {
			f.lifetime.abort();
		}
		assert.equal(assertPresent(signal).aborted, true);
		metadata.resolve(mediaData({ id, metadata: { name: "late" } }));
		await tick();
		assert.equal(reads, 0);
		assert.equal(get(f.viewer).media, null);
		assert.equal(f.created.length, 0);
	});
	test(`${end} cancels content, ignores late progress and cannot create URLs or save dialogs`, async (t) => {
		const content = deferred<Uint8Array<ArrayBuffer>>();
		let request: ContentRequest | undefined;
		const f = fixture(t, {
			getContent: (args) => {
				request = args;
				return content.promise;
			},
		});
		await tick();
		if (end === "dispose") {
			f.viewer.dispose();
		} else {
			f.lifetime.abort();
		}
		assert.equal(assertPresent(assertPresent(request).signal).aborted, true);
		assertPresent(request).onProgress?.(99);
		content.resolve(new Uint8Array([1]));
		await tick();
		assert.equal(f.created.length, 0);
		assert.equal(get(f.viewer).media, null);
		assert.equal(await f.viewer.download(), false);
		assert.equal(f.downloads.length, 0);
	});
}
test("invalid links and undecryptable metadata do not request content", async (t) => {
	let reads = 0;
	const lifetime = new AbortController();
	t.after(() => lifetime.abort());
	const viewer = createMediaViewer(
		"bad",
		{
			key: testKey(),
			serverUrl: "https://clip.example",
			signal: lifetime.signal,
		},
		{
			http: {
				getMedia: async () => {
					reads++;
					throw new Error("unexpected");
				},
				getContent: async () => {
					reads++;
					return new Uint8Array();
				},
			},
		},
	);
	t.after(viewer.dispose);
	await settled(t, viewer);
	assert.equal(get(viewer).error, "Invalid media link.");
	assert.equal(reads, 0);
	const f = fixture(t, {
		getMedia: async () => mediaData({ id, metadata: null }),
		getContent: async () => {
			reads++;
			return new Uint8Array();
		},
	});
	await settled(t, f.viewer);
	assert.equal(get(f.viewer).error, "File metadata is unavailable.");
	assert.equal(reads, 0);
});
