import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type {
	ContentRequest,
	LibraryApi,
	ListRequest,
	MediaPage,
	MetadataResult,
} from "../src/lib/api.ts";
import * as api from "../src/lib/api.ts";
import { createLibrary } from "../src/lib/stores/library.ts";
import type { MediaOptions } from "../src/lib/stores/media-item.ts";
import { createMediaItem } from "../src/lib/stores/media-item.ts";
import { assertPresent } from "./assert.ts";
import { deferred, mediaData, testKey, tick } from "./helpers.ts";
import { captureLogs } from "./log-capture.ts";
import { streamFixture } from "./stream-fixture.ts";

function session() {
	const controller = new AbortController();
	return {
		serverUrl: "https://clip.example",
		key: testKey(),
		signal: controller.signal,
		end: () => controller.abort(),
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
	void library.search();
	owner.signal.addEventListener("abort", library.dispose, { once: true });
	return { owner, library };
}
const item = (id: string) =>
	mediaData({
		id,
		metaHash: "hash",
		bytes: 0,
		createdAt: 0,
		thumb: null,
		metadata: { name: id, tags: [], content_type: "application/octet-stream" },
	});
test("stale searches cannot publish; pagination uses the submitted query and permits one request", async (t) => {
	const logs = captureLogs(t);
	const requests: (ListRequest & {
		done: PromiseWithResolvers<MediaPage>;
	})[] = [];
	const f = fixture(t, {
		http: {
			...api,
			list: (args) => {
				const done = deferred<MediaPage>();
				requests.push({ ...args, done });
				return done.promise;
			},
		},
	});

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
	const stale = logs.find(
		(entry) => entry.event === "[i2nclip] library.search-stale",
	);
	assert.equal(stale?.fields.operation, 1);
	assert.equal(stale?.level, "debug");
	assert(
		!logs.some(
			(entry) =>
				entry.event === "[i2nclip] library.search-completed" &&
				entry.fields.operation === 1,
		),
	);
	assert(
		logs.some(
			(entry) =>
				entry.event === "[i2nclip] library.search-completed" &&
				entry.fields.operation === 3,
		),
	);
	assert(!JSON.stringify(logs).includes("cursor"));
	assert(!JSON.stringify(logs).includes('"new"'));
});
test("identity invalidation suppresses stale searches", async (t) => {
	const result = deferred<MediaPage>();
	const f = fixture(t, { http: { ...api, list: () => result.promise } });

	f.owner.end();
	result.resolve({ items: [item("late")], next: null });
	await tick();
	assert.deepEqual(get(f.library).cards, []);
});
test("stale media downloads create no URLs or save dialogs; disposal revokes previews", async (t) => {
	const owner = session();

	const pending = deferred<Uint8Array<ArrayBuffer>>();
	const created: Array<string> = [];
	const revoked: Array<string> = [];
	let downloads = 0;
	const media = createMediaItem(
		mediaData({
			...item("a"),
			metadata: { name: "a.txt", content_type: "text/plain" },
			thumb: new Uint8Array([1]),
		}),
		owner,
		{
			http: { ...api, readContentRange: () => pending.promise },
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
	const downloading = media.reveal();
	owner.end();
	pending.resolve(new Uint8Array([1, 2]));
	assert.equal(await downloading, false);
	assert.deepEqual(created, ["blob:0"]);
	assert.deepEqual(revoked, ["blob:0"]);
	assert.equal(downloads, 0);
});
test("overlapping media mutations are rejected and conflicts load current metadata before retry", async (t) => {
	const owner = session();

	const pending = deferred<MetadataResult>();
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
			content: null,
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
	const streaming = streamFixture();
	streaming.finish.resolve();
	const f = fixture(t, {
		http: {
			...api,
			list: async () => ({ items: [initial], next: null }),
			readContentRange: async () => new Uint8Array([1, 2, 3, 4]),
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
			streams: streaming.streams,
			download: async (url, name) => downloaded.push({ url, name }),
		},
	});

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
	assert.deepEqual(downloaded, [
		{ url: "/__content/download", name: "Renamed.txt" },
	]);
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

	const pending = deferred<MetadataResult>();
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
	owner.end();
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

	await tick();
	assert.equal(await f.library.remove("a"), false);
	assert.equal(deletes, 0);
	confirmed = true;
	assert.equal(await f.library.remove("a"), false);
	assert.equal(get(f.library).cards[0].deleted, false);
	assert.equal(get(f.library).cards[0].message, "Delete unavailable");
});
test("library previews use view-owned leases and close without reopening", async (t) => {
	const streaming = streamFixture();
	const f = fixture(t, {
		http: {
			list: async () => ({
				items: [
					mediaData({
						id: "image",
						metadata: { name: "image.png", content_type: "image/png" },
					}),
					item("document"),
				],
				next: null,
			}),
		},
		mediaOptions: { streams: streaming.streams },
	});
	await tick();
	assert.equal(await f.library.reveal("document"), false);
	assert.equal(await f.library.reveal("image"), true);
	assert.equal(streaming.previews.length, 1);
	f.library.closePreview();
	assert.equal(streaming.previews[0].disposed, true);
	assert.equal(get(f.library).selected, null);
	assert.equal(await f.library.reveal("image"), true);
	assert.equal(streaming.previews.length, 2);
});
test("rapid preview changes abort old loads and ignore their results, errors and cleanup", async (t) => {
	const loads: (ContentRequest & {
		done: PromiseWithResolvers<Uint8Array<ArrayBuffer>>;
	})[] = [];
	const blobs: Array<Blob | MediaSource> = [];
	const saved: Array<string> = [];
	const items = ["a", "b", "c"].map((id) => ({
		...item(id),
		metadata: { ...item(id).metadata, content_type: "text/plain" },
		thumb: new Uint8Array([1]),
	}));
	const f = fixture(t, {
		http: {
			...api,
			list: async () => ({ items, next: null }),
			readContentRange: (args) => {
				const done = deferred<Uint8Array<ArrayBuffer>>();
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

	await tick();
	const card = (id: string) =>
		get(f.library).cards.find((value) => value.id === id);
	const first = f.library.reveal("a");
	assert.equal(assertPresent(get(f.library).selected).id, "a");
	assert.equal(assertPresent(card("a")).busy, true);
	const second = f.library.reveal("b");
	assert.equal(assertPresent(loads[0].signal).aborted, true);
	assert.equal(assertPresent(card("a")).busy, false);
	assert.equal(assertPresent(get(f.library).selected).id, "b");
	const latest = f.library.reveal("a");
	assert.equal(assertPresent(loads[1].signal).aborted, true);
	assert.equal(loads.length, 3);
	loads[0].done.resolve(new Uint8Array([1]));
	loads[1].done.reject(new Error("late failure"));
	assert.equal(await first, false);
	assert.equal(await second, false);
	assert.equal(assertPresent(card("a")).busy, true);
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
	assert.equal(blobs.length, 3);
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
	f.library.closePreview();
	assert.equal(get(f.library).selected, null);
});
for (const ending of ["close", "search", "lock", "dispose"]) {
	test(`${ending} cancels pending preview work without reporting an error or creating a URL`, async (t) => {
		const pending = deferred<Uint8Array<ArrayBuffer>>();
		let request: ContentRequest | undefined;
		let urls = 0;
		const f = fixture(t, {
			http: {
				...api,
				list: async () => ({
					items: [
						{
							...item("a"),
							metadata: { content_type: "text/plain", name: "a" },
						},
					],
					next: null,
				}),
				readContentRange: (args) => {
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

		await tick();
		const opening = f.library.reveal("a");
		if (ending === "close") {
			f.library.closePreview();
		}
		if (ending === "search") {
			await f.library.search(["new"]);
		}
		if (ending === "lock") {
			f.owner.end();
		}
		if (ending === "dispose") {
			f.library.dispose();
		}
		assert.equal(assertPresent(assertPresent(request).signal).aborted, true);
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
	f.owner.end();
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
	assert.equal(calls.length, 1);

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
	f.owner.end();
	assert.equal(await f.library.clearSearch(), false);
	assert.equal(calls.length, count);
});

test("detached library callbacks preserve their owner across search and media actions", async (t) => {
	let changes = 0;
	const streaming = streamFixture();
	streaming.finish.resolve();
	const f = fixture(t, {
		http: {
			list: async () => ({
				items: [
					{
						...item("a"),
						metadata: { name: "a.png", content_type: "image/png" },
					},
				],
				next: null,
			}),
			updateMetadata: async () => ({
				conflict: false as const,
				metaHash: "updated",
			}),
			remove: async () => {},
		},
		mediaOptions: { streams: streaming.streams, download: () => {} },
		onChange: () => {
			changes++;
		},
	});
	const {
		subscribe,
		editDraft,
		addTag,
		removeTag,
		clearSearch,
		search,
		more,
		refresh,
		reveal,
		closePreview,
		download,
		updateMetadata,
		remove,
	} = f.library;
	const values: string[] = [];
	const unsubscribe = subscribe((value) => values.push(value.searchDraft));
	t.after(unsubscribe);
	await tick();
	editDraft("draft");
	assert.equal(values.at(-1), "draft");
	assert.equal(await addTag("image"), true);
	assert.deepEqual(get(f.library).query, ["image"]);
	assert.equal(await removeTag("image"), true);
	assert.equal(await clearSearch(), true);
	assert.equal(await search(["picture"]), true);
	assert.equal(await more(), false);
	assert.equal(await refresh(), true);
	assert.equal(await reveal("a"), true);
	closePreview();
	assert.equal(get(f.library).selected, null);
	assert.equal(await download("a"), true);
	assert.equal(await updateMetadata("a", { name: "renamed.png" }), true);
	assert.equal(await remove("a"), true);
	assert.equal(changes, 2);
});

test("disposing one library does not cancel or publish into another instance", async (t) => {
	const pending: Array<
		ListRequest & { done: PromiseWithResolvers<MediaPage> }
	> = [];
	const http = {
		list: (request: ListRequest) => {
			const done = deferred<MediaPage>();
			pending.push({ ...request, done });
			return done.promise;
		},
	};
	const first = fixture(t, { http });
	const second = fixture(t, { http });
	t.after(() => {
		for (const request of pending) {
			request.done.resolve({ items: [], next: null });
		}
	});
	first.library.editDraft("first");
	second.library.editDraft("second");
	const { dispose } = first.library;
	dispose();
	assert.equal(assertPresent(pending[0].signal).aborted, true);
	assert.equal(assertPresent(pending[1].signal).aborted, false);
	pending[0].done.resolve({ items: [item("stale")], next: null });
	pending[1].done.resolve({ items: [item("live")], next: "cursor" });
	await tick();
	assert.deepEqual(get(first.library).cards, []);
	assert.equal(get(first.library).searchDraft, "");
	assert.deepEqual(
		get(second.library).cards.map((card) => card.id),
		["live"],
	);
	assert.equal(get(second.library).searchDraft, "second");
	const { more } = second.library;
	const loading = more();
	assert.equal(pending[2].after, "cursor");
	pending[2].done.resolve({ items: [item("next")], next: null });
	assert.equal(await loading, true);
	assert.deepEqual(
		get(second.library).cards.map((card) => card.id),
		["live", "next"],
	);
});
