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
	metadata: { name: id, tags: [], content_type: "application/octet-stream" },
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

test("uploads run sequentially, continue after failures, and retain only failed files for retry", async (t) => {
	const active = deferred();
	const entered = deferred();
	const seen = [];
	let fail = true;
	let oldProgress;
	const f = fixture(t, {
		http: { list: async () => ({ items: [], next: null }) },
		send: async ({ file, onProgress }) => {
			seen.push(file.name);
			if (file.name === "first") {
				oldProgress = onProgress;
				entered.resolve();
				await active.promise;
			}
			if (file.name === "bad" && fail) {
				throw new Error("network failed");
			}
			return { id: file.name };
		},
	});
	f.owner.configure();
	await tick();
	const files = ["first", "bad", "last"].map((name) => ({ name }));
	const uploading = f.library.upload(files);
	await entered.promise;
	assert.deepEqual(seen, ["first"]);
	assert.equal(await f.library.upload([{ name: "overlap" }]), false);
	active.resolve();
	assert.equal(await uploading, false);
	assert.deepEqual(seen, ["first", "bad", "last"]);
	assert.deepEqual(get(f.library).uploadFailures, [
		{ name: "bad", error: "network failed" },
	]);
	oldProgress(99);
	assert.equal(get(f.library).uploadProgress, null);
	fail = false;
	assert.equal(await f.library.retryUploads(), true);
	assert.deepEqual(seen, ["first", "bad", "last", "bad"]);
	assert.deepEqual(get(f.library).uploadFailures, []);
});

test("identity invalidation clears retry files and suppresses stale uploads and searches", async (t) => {
	const result = deferred();
	const upload = deferred();
	const f = fixture(t, {
		http: { list: () => result.promise },
		send: () => upload.promise,
	});
	f.owner.configure();
	const sending = f.library.upload([{ name: "pending" }]);
	f.owner.lock();
	upload.resolve({ id: "late" });
	result.resolve({ items: [item("late")], next: null });
	await sending;
	await tick();
	assert.deepEqual(get(f.library).cards, []);
	assert.deepEqual(get(f.library).uploadFailures, []);
	assert.deepEqual(get(f.library).uploadCompleted, []);
	assert.equal(get(f.library).uploading, false);
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

test("overlapping media mutations are rejected and metadata conflicts refresh tags before retry", async (t) => {
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
	const saving = media.retag(["mine"]);
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
	assert.deepEqual(get(media).metadata.tags, ["other"]);
	assert.match(get(media).message, /another device/);
	assert.equal(await media.remove(), true);
	assert.equal(get(media).deleted, true);
});
