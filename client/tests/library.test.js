import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createLibrary } from "../src/lib/stores/library.js";
import { createMediaItem } from "../src/lib/stores/media-item.js";
import { deferred, tick } from "./helpers.js";

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
			privateKey: "key",
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
function fixture(t, options = {}) {
	const owner = session();
	const library = createLibrary(owner, { confirm: () => true, ...options });
	t.after(library.dispose);
	return { owner, library };
}
const item = (id) => ({
	id,
	metaHash: "hash",
	metadata: { name: id, tags: [], contentType: "application/octet-stream" },
});

test("stale searches cannot publish; pagination uses the submitted query and permits one request", async (t) => {
	const requests = [];
	const f = fixture(t, {
		http: {
			list: (args) => {
				const done = deferred();
				requests.push({ ...args, done });
				return done.promise;
			},
		},
	});
	f.owner.configure();
	const searching = f.library.search("new");
	assert.equal(requests[0].signal.aborted, true);
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
	assert.equal(requests[2].tags, "new");
	assert.equal(requests[2].after, "cursor");
	requests[2].done.resolve({ items: [item("second")], next: null });
	await more;
	assert.deepEqual(
		get(f.library).cards.map((v) => v.id),
		["new", "second"],
	);
});

test("identity invalidation suppresses stale searches", async (t) => {
	const result = deferred();
	const f = fixture(t, { http: { list: () => result.promise } });
	f.owner.configure();
	f.owner.lock();
	result.resolve({ items: [item("late")], next: null });
	await tick();
	assert.deepEqual(get(f.library).cards, []);
});

test("stale media downloads create no URLs or save dialogs; disposal revokes previews", async (t) => {
	const owner = session();
	owner.configure();
	const pending = deferred();
	const created = [];
	const revoked = [];
	let downloads = 0;
	const media = createMediaItem(
		{ ...item("a"), thumb: new Uint8Array([1]) },
		owner,
		{
			http: { getContent: () => pending.promise },
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
	const pending = deferred();
	let calls = 0;
	const media = createMediaItem(item("a"), owner, {
		http: {
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
		conflict: true,
		item: {
			...item("a"),
			metaHash: "new",
			metadata: { ...item("a").metadata, tags: ["other"] },
		},
	});
	assert.equal(await saving, false);
	assert.equal(get(media).metadata.name, "a");
	assert.deepEqual(get(media).metadata.tags, ["other"]);
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
			contentType: "text/plain",
			size: 4,
			camera: { model: "Example" },
		},
		thumb: new Uint8Array([1, 2, 3]),
	};
	const requests = [];
	const downloaded = [];
	const revoked = [];
	const f = fixture(t, {
		http: {
			list: async () => ({ items: [initial], next: null }),
			getContent: async () => new Uint8Array([1, 2, 3, 4]),
			updateMetadata: async (request) => {
				requests.push(request);
				return { conflict: false, metaHash: `hash${requests.length}` };
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
	const pending = deferred();
	let fail = true;
	const media = createMediaItem(item("Original.txt"), owner, {
		http: {
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
	assert.equal(get(media).metadata.name, "Original.txt");
	fail = false;
	const updating = media.updateMetadata({ name: "Stale.txt" });
	assert.equal(await media.updateMetadata({ name: "Overlapping.txt" }), false);
	owner.lock();
	pending.resolve({ conflict: false, metaHash: "new" });
	assert.equal(await updating, false);
	assert.equal(get(media).metadata.name, "Original.txt");
});

test("deleted cards retain their position and pagination, release URLs, and disappear on search", async (t) => {
	const revoked = [];
	let listed = 0;
	let deletes = 0;
	const f = fixture(t, {
		http: {
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
	await f.library.search("");
	assert.deepEqual(get(f.library).cards, []);
	assert.equal(get(f.library).empty, "library");
});

test("failed and canceled deletions preserve active cards", async (t) => {
	let confirmed = false;
	let deletes = 0;
	const f = fixture(t, {
		confirm: () => confirmed,
		http: {
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
	const requests = [];
	const downloads = [];
	const created = [];
	const revoked = [];
	const playable = (id, contentType) => ({
		...item(id),
		metadata: { ...item(id).metadata, contentType },
	});
	const f = fixture(t, {
		http: {
			list: (args) => {
				const done = deferred();
				requests.push({ ...args, done });
				return done.promise;
			},
			getContent: (args) => {
				const done = deferred();
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
	const searching = f.library.search("submitted");
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
	assert.equal(get(f.library).selected.id, "audio");
	assert.equal(get(f.library).selected.type, "audio/wav");
	const pendingDownload = f.library.reveal("video");
	f.library.closePreview();
	downloads[2].done.resolve(new Uint8Array([3]));
	await pendingDownload;
	assert.equal(get(f.library).selected, null);
	assert.equal(await f.library.reveal("video"), true);
	assert.equal(get(f.library).selected.type, "video/webm");
	f.library.dispose();
	assert.deepEqual(revoked, created);
});
