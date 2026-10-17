import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import type { LibraryApi } from "../src/lib/api.ts";
import * as api from "../src/lib/api.ts";
import { createLibrary } from "../src/lib/stores/library.ts";
import type { MediaOptions } from "../src/lib/stores/media-item.ts";
import { createMediaItem } from "../src/lib/stores/media-item.ts";
import { assertPresent } from "./assert.ts";
import { deferred, mediaData, testKey, tick } from "./helpers.ts";

function session() {
	const state = writable({
		configured: false,
		unlocked: true,
		busy: false,
		epoch: 0,
	});
	let controller = new AbortController();
	return {
		...state,
		get epoch() {
			return get(state).epoch;
		},
		get signal() {
			return controller.signal;
		},
		credentials: () => ({
			serverUrl: "https://clip.example",
			key: testKey(),
		}),
		configure() {
			state.update((v) => ({ ...v, configured: true }));
		},
		lock() {
			controller.abort();
			controller = new AbortController();
			state.update((v) => ({
				...v,
				configured: false,
				unlocked: false,
				epoch: v.epoch + 1,
			}));
		},
	};
}
function fixture(
	t: test.TestContext,
	options: {
		http?: Partial<LibraryApi>;
		mediaOptions?: MediaOptions;
		onChange?: () => unknown;
		confirm?: (message: string) => boolean;
	} = {},
) {
	const owner = session();
	const library = createLibrary(owner, {
		confirm: () => true,
		...options,
		http: { ...api, ...options.http },
	});
	t.after(library.dispose);
	return { owner, library };
}
const item = (id: string) => ({
	id,
	metaHash: "hash",
	bytes: 0,
	createdAt: 0,
	thumb: null,
	metadata: { name: id, tags: [], content_type: "application/octet-stream" },
});
test("stale searches cannot publish; pagination uses the submitted query and permits one request", async (t) => {
	const requests: (Parameters<typeof api.list>[0] & {
		done: ReturnType<typeof deferred<Awaited<ReturnType<typeof api.list>>>>;
	})[] = [];
	const f = fixture(t, {
		http: {
			...api,
			list: (args) => {
				const done = deferred<Awaited<ReturnType<typeof api.list>>>();
				requests.push({ ...args, done });
				return done.promise;
			},
		},
	});
	f.owner.configure();
	const searching = f.library.search(["new"]);
	assert.equal(assertPresent(requests[0].signal).aborted, true);
	requests[1].done.resolve({ items: [item("new")], next: "cursor" });
	await searching;
	requests[0].done.resolve({ items: [item("old")], next: "stale" });
	await tick();
	assert.deepEqual(
		get(f.library).cards.map((v) => v.id),
		["new"],
	);
	f.library.editDraft("unsubmitted");
	const more = f.library.more();
	assert.equal(await f.library.more(), false);
	assert.deepEqual(requests[2].tags, ["new"]);
	assert.equal(requests[2].after, "cursor");
	requests[2].done.resolve({ items: [item("second")], next: null });
	await more;
	assert.deepEqual(
		get(f.library).cards.map((v) => v.id),
		["new", "second"],
	);
});
test("identity invalidation suppresses stale searches", async (t) => {
	const result = deferred<Awaited<ReturnType<typeof api.list>>>();
	const f = fixture(t, { http: { ...api, list: () => result.promise } });
	f.owner.configure();
	f.owner.lock();
	result.resolve({ items: [item("late")], next: null });
	await tick();
	assert.deepEqual(get(f.library).cards, []);
});
test("stale media downloads create no URLs or save dialogs; disposal revokes previews", async (t) => {
	const owner = session();
	owner.configure();
	const pending = deferred<Uint8Array<ArrayBuffer>>();
	const created: Array<string> = [];
	const revoked: Array<string> = [];
	let downloads = 0;
	const media = createMediaItem(
		mediaData({ ...item("a"), thumb: new Uint8Array([1]) }),
		owner,
		{
			http: { ...api, getContent: () => pending.promise },
			urls: {
				createObjectURL: () => {
					const value = `blob:${created.length}`;
					created.push(value);
					return value;
				},
				revokeObjectURL: (value) => revoked.push(value),
			},
			download: () => downloads++,
		},
	);
	t.after(media.dispose);
	const downloading = media.download();
	owner.lock();
	pending.resolve(new Uint8Array([1, 2]));
	assert.equal(await downloading, false);
	assert.deepEqual(created, ["blob:0"]);
	assert.deepEqual(revoked, ["blob:0"]);
	assert.equal(downloads, 0);
});
test("overlapping media mutations are rejected and conflicts load current metadata before retry", async (t) => {
	const owner = session();
	owner.configure();
	const pending = deferred<Awaited<ReturnType<typeof api.updateMetadata>>>();
	let calls = 0;
	const media = createMediaItem(mediaData(item("a")), owner, {
		http: {
			...api,
			updateMetadata: () => {
				calls++;
				return pending.promise;
			},
			remove: async () => {},
		},
	});
	t.after(media.dispose);
	const saving = media.updateMetadata({ name: "Renamed.txt", tags: ["mine"] });
	assert.equal(await media.remove(), false);
	assert.equal(calls, 1);
	pending.resolve({
		conflict: true as const,
		item: {
			...item("a"),
			metaHash: "new",
			metadata: { ...item("a").metadata, tags: ["other"] },
		},
	});
	assert.equal(await saving, false);
	assert.equal(assertPresent(get(media).metadata).name, "a");
	assert.deepEqual(assertPresent(get(media).metadata).tags, ["other"]);
	assert.match(get(media).message, /another device/);
	assert.equal(await media.remove(), true);
	assert.equal(get(media).deleted, true);
});
test("generic metadata updates rename files, preserve omitted fields and previews, and normalize supplied tags", async (t) => {
	const initial = {
		...item("a"),
		metadata: {
			name: "Original.txt",
			tags: ["Keep"],
			content_type: "text/plain",
			size: 4,
			camera: { model: "Example" },
		},
		thumb: new Uint8Array([1, 2, 3]),
	};
	const requests: Array<
		api.Credentials & {
			id: string;
			metadata: import("../src/lib/protocol/meta-plain.ts").Metadata;
			thumb?: Uint8Array<ArrayBuffer> | null;
			prevMetaHash: string;
			signal?: AbortSignal;
		}
	> = [];
	const downloaded: Array<{
		url: string;
		name: string;
	}> = [];
	const revoked: Array<string> = [];
	const f = fixture(t, {
		http: {
			...api,
			list: async () => ({ items: [initial], next: null }),
			getContent: async () => new Uint8Array([1, 2, 3, 4]),
			updateMetadata: async (request) => {
				requests.push(request);
				return { conflict: false as const, metaHash: `hash${requests.length}` };
			},
		},
		mediaOptions: {
			urls: {
				createObjectURL: () => "blob:owned",
				revokeObjectURL: (url) => revoked.push(url),
			},
			download: async (url, name) => downloaded.push({ url, name }),
		},
	});
	f.owner.configure();
	await tick();
	assert.equal(
		await f.library.updateMetadata("a", { name: "Renamed.txt" }),
		true,
	);
	assert.deepEqual(requests[0].metadata, {
		...initial.metadata,
		name: "Renamed.txt",
	});
	assert.equal(requests[0].prevMetaHash, initial.metaHash);
	assert.deepEqual(requests[0].thumb, initial.thumb);
	assert.equal(get(f.library).cards[0].preview, "blob:owned");
	await f.library.download("a");
	assert.deepEqual(downloaded, [{ url: "blob:owned", name: "Renamed.txt" }]);
	assert.equal(
		await f.library.updateMetadata("a", {
			tags: [" Vacation ", "vacation", "Keep"],
		}),
		true,
	);
	assert.deepEqual(requests[1].metadata, {
		...initial.metadata,
		name: "Renamed.txt",
		tags: ["Vacation", "Keep"],
	});
	assert.equal(requests[1].prevMetaHash, "hash1");
	assert.equal(
		await f.library.updateMetadata("a", { name: "Final.txt", tags: ["Final"] }),
		true,
	);
	assert.deepEqual(get(f.library).cards[0].metadata, {
		...initial.metadata,
		name: "Final.txt",
		tags: ["Final"],
	});
	assert.deepEqual(revoked, []);
});
test("failed and stale metadata updates never publish an attempted filename", async (t) => {
	const owner = session();
	owner.configure();
	const pending = deferred<Awaited<ReturnType<typeof api.updateMetadata>>>();
	let fail = true;
	const media = createMediaItem(mediaData(item("Original.txt")), owner, {
		http: {
			...api,
			updateMetadata: async () => {
				if (fail) {
					throw new Error("Unavailable");
				}
				return pending.promise;
			},
		},
	});
	t.after(media.dispose);
	assert.equal(await media.updateMetadata({ name: "Failed.txt" }), false);
	assert.equal(assertPresent(get(media).metadata).name, "Original.txt");
	fail = false;
	const updating = media.updateMetadata({ name: "Stale.txt" });
	assert.equal(await media.updateMetadata({ name: "Overlapping.txt" }), false);
	owner.lock();
	pending.resolve({ conflict: false as const, metaHash: "new" });
	assert.equal(await updating, false);
	assert.equal(assertPresent(get(media).metadata).name, "Original.txt");
});
test("deleted cards retain their position and pagination, release URLs, and disappear on search", async (t) => {
	const revoked: Array<string> = [];
	let listed = 0;
	let deletes = 0;
	const f = fixture(t, {
		http: {
			...api,
			list: async () => ({
				items: listed++ ? [] : [{ ...item("a"), thumb: new Uint8Array([1]) }],
				next: listed === 1 ? "cursor" : null,
			}),
			remove: async () => {
				deletes++;
			},
		},
		mediaOptions: {
			urls: {
				createObjectURL: () => "blob:preview",
				revokeObjectURL: (url) => revoked.push(url),
			},
		},
	});
	f.owner.configure();
	await tick();
	assert.equal(await f.library.remove("a"), true);
	assert.equal(get(f.library).cards.length, 1);
	assert.equal(get(f.library).cards[0].deleted, true);
	assert.equal(get(f.library).cards[0].preview, "");
	assert.deepEqual(revoked, ["blob:preview"]);
	assert.equal(get(f.library).next, "cursor");
	assert.equal(get(f.library).empty, null);
	assert.equal(await f.library.remove("a"), false);
	assert.equal(deletes, 1);
	assert.equal(await f.library.download("a"), false);
	await f.library.search([]);
	assert.deepEqual(get(f.library).cards, []);
	assert.equal(get(f.library).empty, "library");
});
test("failed and canceled deletions preserve active cards", async (t) => {
	let confirmed = false;
	let deletes = 0;
	const f = fixture(t, {
		confirm: () => confirmed,
		http: {
			...api,
			list: async () => ({ items: [item("a")], next: null }),
			remove: async () => {
				deletes++;
				throw new Error("Delete unavailable");
			},
		},
	});
	f.owner.configure();
	await tick();
	assert.equal(await f.library.remove("a"), false);
	assert.equal(deletes, 0);
	confirmed = true;
	assert.equal(await f.library.remove("a"), false);
	assert.equal(get(f.library).cards[0].deleted, false);
	assert.equal(get(f.library).cards[0].message, "Delete unavailable");
});
test("loaded previews skip files, reuse downloads, and never reopen after close", async (t) => {
	const requests: (Parameters<typeof api.list>[0] & {
		done: ReturnType<typeof deferred<Awaited<ReturnType<typeof api.list>>>>;
	})[] = [];
	const downloads: (Parameters<typeof api.getContent>[0] & {
		done: ReturnType<
			typeof deferred<Awaited<ReturnType<typeof api.getContent>>>
		>;
	})[] = [];
	const created: Array<string> = [];
	const revoked: Array<string> = [];
	const playable = (id: string, content_type: string) => ({
		...item(id),
		metadata: { ...item(id).metadata, content_type },
	});
	const f = fixture(t, {
		http: {
			...api,
			list: (args) => {
				const done = deferred<Awaited<ReturnType<typeof api.list>>>();
				requests.push({ ...args, done });
				return done.promise;
			},
			getContent: (args) => {
				const done = deferred<Awaited<ReturnType<typeof api.getContent>>>();
				downloads.push({ ...args, done });
				return done.promise;
			},
		},
		mediaOptions: {
			urls: {
				createObjectURL: () => {
					const url = `blob:${created.length}`;
					created.push(url);
					return url;
				},
				revokeObjectURL: (url) => revoked.push(url),
			},
		},
	});
	t.after(() => {
		for (const request of requests) {
			request.done.resolve({ items: [], next: null });
		}
		for (const request of downloads) {
			request.done.resolve(new Uint8Array([1]));
		}
	});
	f.owner.configure();
	requests[0].done.resolve({ items: [], next: null });
	await tick();
	const searching = f.library.search(["submitted"]);
	requests[1].done.resolve({
		items: [
			playable("image", "image/png"),
			item("document"),
			playable("audio", "audio/wav"),
			playable("video", "video/webm"),
		],
		next: "files",
	});
	await searching;
	f.library.editDraft("not submitted");
	assert.equal(await f.library.reveal("document"), false);
	const opening = f.library.reveal("image");
	downloads[0].done.resolve(new Uint8Array([1]));
	await opening;
	assert.equal(await f.library.reveal("image"), true);
	assert.equal(downloads.length, 1);
	assert.equal(requests.length, 2);
	const openingAudio = f.library.reveal("audio");
	downloads[1].done.resolve(new Uint8Array([2]));
	assert.equal(await openingAudio, true);
	assert.equal(assertPresent(get(f.library).selected).id, "audio");
	assert.equal(
		assertPresent(
			assertPresent(get(f.library).cards.find((card) => card.id === "audio"))
				.metadata,
		).content_type,
		"audio/wav",
	);
	const pendingDownload = f.library.reveal("video");
	f.library.closePreview();
	downloads[2].done.resolve(new Uint8Array([3]));
	await pendingDownload;
	assert.equal(get(f.library).selected, null);
	const reopeningVideo = f.library.reveal("video");
	assert.equal(downloads.length, 4);
	downloads[3].done.resolve(new Uint8Array([3]));
	assert.equal(await reopeningVideo, true);
	assert.equal(
		assertPresent(
			assertPresent(get(f.library).cards.find((card) => card.id === "video"))
				.metadata,
		).content_type,
		"video/webm",
	);
	f.library.dispose();
	assert.deepEqual(revoked, created);
});
test("rapid preview changes abort old loads and ignore their progress, results, errors and cleanup", async (t) => {
	const loads: (Parameters<typeof api.getContent>[0] & {
		done: ReturnType<
			typeof deferred<Awaited<ReturnType<typeof api.getContent>>>
		>;
	})[] = [];
	const blobs: Array<Blob | MediaSource> = [];
	const saved: Array<string> = [];
	const items = ["a", "b", "c"].map((id) => ({
		...item(id),
		metadata: { ...item(id).metadata, content_type: "image/png" },
		thumb: new Uint8Array([1]),
	}));
	const f = fixture(t, {
		http: {
			...api,
			list: async () => ({ items, next: null }),
			getContent: (args) => {
				const done = deferred<Awaited<ReturnType<typeof api.getContent>>>();
				loads.push({ ...args, done });
				return done.promise;
			},
		},
		mediaOptions: {
			urls: {
				createObjectURL: (blob) => {
					blobs.push(blob);
					return `blob:${blobs.length}`;
				},
				revokeObjectURL() {},
			},
			download: (url) => saved.push(url),
		},
	});
	t.after(() => {
		for (const load of loads) {
			load.done.resolve(new Uint8Array([1]));
		}
	});
	f.owner.configure();
	await tick();
	const card = (id: string) =>
		get(f.library).cards.find((value) => value.id === id);
	const first = f.library.reveal("a");
	assert.equal(assertPresent(get(f.library).selected).id, "a");
	assert.equal(assertPresent(card("a")).busy, true);
	assertPresent(loads[0].onProgress)(17);
	assert.equal(assertPresent(card("a")).progress, 17);
	const second = f.library.reveal("b");
	assert.equal(assertPresent(loads[0].signal).aborted, true);
	assert.equal(assertPresent(card("a")).busy, false);
	assert.equal(assertPresent(card("a")).progress, null);
	assert.equal(assertPresent(get(f.library).selected).id, "b");
	const latest = f.library.reveal("a");
	assert.equal(assertPresent(loads[1].signal).aborted, true);
	assert.equal(loads.length, 3);
	assertPresent(loads[2].onProgress)(42);
	assertPresent(loads[0].onProgress)(99);
	loads[0].done.resolve(new Uint8Array([1]));
	loads[1].done.reject(new Error("late failure"));
	assert.equal(await first, false);
	assert.equal(await second, false);
	assert.equal(assertPresent(card("a")).busy, true);
	assert.equal(assertPresent(card("a")).progress, 42);
	assert.equal(assertPresent(card("b")).message, "");
	assert.equal(
		blobs.length,
		3,
		"only initial thumbnails exist before the current load finishes",
	);
	loads[2].done.resolve(new Uint8Array([2]));
	assert.equal(await latest, true);
	assert.equal(assertPresent(get(f.library).selected).id, "a");
	assert.equal(assertPresent(card("a")).error, false);
	assert.equal(blobs.length, 4);
	assert.equal(await f.library.reveal("a"), true);
	assert.equal(loads.length, 3, "completed content remains cached");
	const pending = f.library.reveal("c");
	f.library.closePreview();
	assert.equal(assertPresent(loads[3].signal).aborted, true);
	assert.equal(assertPresent(card("c")).busy, false);
	const reopened = f.library.reveal("c");
	loads[3].done.resolve(new Uint8Array([3]));
	assert.equal(await pending, false);
	assert.equal(assertPresent(card("c")).busy, true);
	assert.equal(assertPresent(card("c")).url, "");
	loads[4].done.resolve(new Uint8Array([4]));
	assert.equal(await reopened, true);
	const saving = f.library.download("b");
	f.library.closePreview();
	assert.equal(
		assertPresent(loads[5].signal).aborted,
		false,
		"close does not cancel an explicit download",
	);
	loads[5].done.resolve(new Uint8Array([5]));
	assert.equal(await saving, true);
	assert.equal(saved.length, 1);
	assert.equal(get(f.library).selected, null);
});
for (const ending of ["close", "search", "lock", "dispose"]) {
	test(`${ending} cancels pending preview work without reporting an error or creating a URL`, async (t) => {
		const pending = deferred<Uint8Array<ArrayBuffer>>();
		let request: Parameters<typeof api.getContent>[0] | undefined;
		let urls = 0;
		const f = fixture(t, {
			http: {
				...api,
				list: async () => ({
					items: [
						{
							...item("a"),
							metadata: { content_type: "image/png", name: "a" },
						},
					],
					next: null,
				}),
				getContent: (args) => {
					request = args;
					return pending.promise;
				},
			},
			mediaOptions: {
				urls: {
					createObjectURL() {
						urls++;
						return "blob:late";
					},
					revokeObjectURL() {},
				},
			},
		});
		t.after(() => pending.resolve(new Uint8Array([1])));
		f.owner.configure();
		await tick();
		const opening = f.library.reveal("a");
		if (ending === "close") {
			f.library.closePreview();
		}
		if (ending === "search") {
			await f.library.search(["new"]);
		}
		if (ending === "lock") {
			f.owner.lock();
		}
		if (ending === "dispose") {
			f.library.dispose();
		}
		assert.equal(assertPresent(assertPresent(request).signal).aborted, true);
		assertPresent(assertPresent(request).onProgress)(90);
		pending.resolve(new Uint8Array([1]));
		assert.equal(await opening, false);
		assert.equal(get(f.library).selected, null);
		assert.equal(urls, 0);
	});
}
test("chip search preserves multiword tags, deduplicates, clears, and rejects invalid input", async (t) => {
	const calls: Array<
		api.Credentials & {
			tags?: string[] | string;
			after?: string | null;
			signal?: AbortSignal;
		}
	> = [];
	const f = fixture(t, {
		http: {
			...api,
			list: async (args) => {
				calls.push(args);
				return { items: [], next: null };
			},
		},
	});
	f.owner.configure();
	await tick();
	f.library.editDraft("summer holiday");
	await f.library.addTag("summer holiday");
	assert.deepEqual(get(f.library).query, ["summer holiday"]);
	assert.equal(get(f.library).searchDraft, "");
	await f.library.addTag("SUMMER HOLIDAY");
	assert.deepEqual(get(f.library).query, ["summer holiday"]);
	await f.library.addTag("image");
	assert.deepEqual(assertPresent(calls.at(-1)).tags, [
		"summer holiday",
		"image",
	]);
	await f.library.removeTag("image");
	assert.deepEqual(assertPresent(calls.at(-1)).tags, ["summer holiday"]);
	f.library.editDraft("bad,tag");
	assert.equal(await f.library.addTag("bad,tag"), false);
	assert.equal(get(f.library).searchDraft, "bad,tag");
	await f.library.clearSearch();
	assert.deepEqual(get(f.library).query, []);
	assert.equal(get(f.library).searchDraft, "");
	f.owner.lock();
	assert.deepEqual(get(f.library).query, []);
});
test("search admission preserves drafts and rejects excess tags before replacing results", async (t) => {
	const calls: Array<
		api.Credentials & {
			tags?: string[] | string;
			after?: string | null;
			signal?: AbortSignal;
		}
	> = [];
	const f = fixture(t, {
		http: {
			...api,
			list: async (args) => {
				calls.push(args);
				return { items: [], next: null };
			},
		},
	});
	f.library.editDraft("Café");
	assert.equal(await f.library.addTag("Café"), false);
	assert.equal(get(f.library).searchDraft, "Café");
	assert.equal(calls.length, 0);
	f.owner.configure();
	await tick();
	const tags = Array.from({ length: 63 }, (_, i) => `tag${i}`);
	await f.library.search([...tags, " Café ", "CAFE\u0301"]);
	assert.deepEqual(get(f.library).query, [...tags, "Café"]);
	assert.equal(get(f.library).searchDraft, "Café");
	await f.library.addTag("CAFÉ");
	assert.equal(get(f.library).query.length, 64);
	assert.equal(get(f.library).searchDraft, "");
	f.library.editDraft("overflow");
	const count = calls.length;
	assert.equal(await f.library.addTag("overflow"), false);
	assert.equal(get(f.library).searchDraft, "overflow");
	assert.deepEqual(get(f.library).query, [...tags, "Café"]);
	assert.equal(calls.length, count);
	assert.match(get(f.library).status, /maximum 64/);
	f.owner.update((v) => ({ ...v, busy: true }));
	assert.equal(await f.library.clearSearch(), false);
	assert.equal(get(f.library).searchDraft, "overflow");
	assert.equal(calls.length, count);
});
