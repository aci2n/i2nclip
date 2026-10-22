import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createSessionStorage } from "../src/lib/storage/session.ts";
import type { ChainStore, ChainView } from "../src/lib/stores/chain.ts";
import { createMaterializedView } from "../src/lib/stores/materialized-view.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { createUploads } from "../src/lib/stores/uploads.ts";
import { deferred } from "./helpers.ts";
import { initialSessionState, registerSession } from "./library-fixture.ts";
import { memoryStorage } from "./memory-database.ts";

async function fixture(t: test.TestContext, uninitialized = false) {
	const session = createSession({
		persistence: createSessionStorage(memoryStorage().connect()),
		download: () => {},
		http: { registered: async () => false, register: async () => {} },
		verify: async (_identity, head) => head,
	});
	t.after(session.dispose);
	await session.load();
	await session.initialize("local password");
	await registerSession(session, {
		serverUrl: "https://example.test",
		otc: "invite",
	});
	const context = get(session).context;
	assert.ok(context);
	const initial = await initialSessionState(session);
	const state = writable<ChainView>({
		live: uninitialized ? null : initial,
		syncing: false,
		error: "",
		storageError: "",
	});
	const chain: ChainStore = {
		subscribe: state.subscribe,
		at: async () => initial,
		sync: async () => {
			state.update((value) => ({ ...value, live: initial }));
			return initial;
		},
		append: async () => {
			throw new Error("Unused");
		},
		dispose() {},
	};
	const view = createMaterializedView(
		chain,
		{
			metadata: async () => {
				throw new Error("Unused");
			},
		},
		context.signal,
	);
	t.after(view.dispose);
	const preferences = createPreferences(memoryStorage().connect());
	t.after(preferences.dispose);
	await preferences.load();
	return { session, view, preferences, context, state };
}
/** A quota check that admits files up to `limit` plaintext bytes. */
function quota(limit = 1024 * 1024, onRead = () => {}) {
	return async (size: number) => {
		onRead();
		if (size > limit) {
			throw new Error("This file exceeds the available storage quota.");
		}
	};
}

test("uploads continue after individual failures and ignore late progress", async (t) => {
	const f = await fixture(t);
	const names: string[] = [];
	const late: Array<(percent: number) => void> = [];
	let reads = 0;
	const uploads = createUploads(
		f.session,
		f.view,
		{
			upload: async (options) => {
				const name = String(options.attributes.name);
				names.push(name);
				if (options.onProgress) {
					late.push(options.onProgress);
				}
				if (name === "failed.txt") {
					throw new Error("Upload rejected");
				}
				return { id: "ab".repeat(32) };
			},
			checkQuota: quota(undefined, () => reads++),
		},
		f.preferences,
		f.context.signal,
		{
			prepare: async ({ file }) => {
				assert.ok(reads > 0);
				return file;
			},
			thumbnail: async () => null,
		},
	);
	t.after(uploads.dispose);
	assert.equal(
		await uploads.upload([
			new File(["bad"], "failed.txt"),
			new File(["good"], "good.txt"),
		]),
		false,
	);
	assert.deepEqual(names, ["failed.txt", "good.txt"]);
	assert.equal(get(uploads).failures.length, 1);
	assert.equal(get(uploads).completed.length, 1);
	const finished = get(uploads);
	for (const progress of late) {
		progress(45);
	}
	assert.equal(get(uploads), finished);
});

test("unsupported local sizes are rejected before preparation or quota reads", async (t) => {
	const f = await fixture(t);
	let prepared = 0;
	let reads = 0;
	const uploads = createUploads(
		f.session,
		f.view,
		{
			upload: async () => ({ id: "unused" }),
			checkQuota: quota(undefined, () => reads++),
		},
		f.preferences,
		f.context.signal,
		{
			prepare: async ({ file }) => {
				prepared++;
				return file;
			},
			thumbnail: async () => null,
		},
	);
	t.after(uploads.dispose);
	const huge = new File([], "huge.bin");
	Object.defineProperty(huge, "size", { value: Number.MAX_SAFE_INTEGER });
	assert.equal(await uploads.upload([huge]), false);
	assert.equal(reads, 0);
	assert.equal(prepared, 0);
	assert.equal(get(uploads).failures.length, 1);
});

test("selecting a historical view cancels preparation and prevents publishing", async (t) => {
	const f = await fixture(t);
	const preparing = deferred();
	const prepared = deferred<File>();
	let published = 0;
	const uploads = createUploads(
		f.session,
		f.view,
		{
			upload: async () => {
				published++;
				return { id: "unused" };
			},
			checkQuota: quota(),
		},
		f.preferences,
		f.context.signal,
		{
			prepare: async () => {
				preparing.resolve();
				return prepared.promise;
			},
			thumbnail: async () => null,
		},
	);
	t.after(uploads.dispose);
	const file = new File(["hello"], "hello.txt");
	const uploading = uploads.upload([file]);
	await preparing.promise;
	assert.equal(await f.view.select(0), true);
	prepared.resolve(file);
	assert.equal(await uploading, false);
	assert.equal(published, 0);
	assert.equal(get(uploads).uploading, false);
	assert.equal(await uploads.upload([file]), false);
});

test("bounded eligible compression can bring an oversized image under quota before upload", async (t) => {
	const f = await fixture(t);
	let prepared = 0;
	let thumbnails = 0;
	let uploaded = 0;
	let fits = true;
	const uploads = createUploads(
		f.session,
		f.view,
		{
			upload: async (options) => {
				uploaded++;
				assert.equal(options.file.size, 100);
				assert.equal(options.attributes.name, "small.webp");
				return { id: "ab".repeat(32) };
			},
			checkQuota: quota(1000),
		},
		f.preferences,
		f.context.signal,
		{
			prepare: async ({ file }) => {
				prepared++;
				return fits
					? new File([new Uint8Array(100)], "small.webp", {
							type: "image/webp",
						})
					: file;
			},
			thumbnail: async () => {
				thumbnails++;
				return null;
			},
		},
	);
	t.after(uploads.dispose);
	assert.equal(
		await uploads.upload([
			new File([new Uint8Array(2048)], "large.png", { type: "image/png" }),
		]),
		true,
	);
	assert.equal(prepared, 1);
	assert.equal(thumbnails, 1);
	assert.equal(uploaded, 1);
	fits = false;
	assert.equal(
		await uploads.upload([
			new File([new Uint8Array(2048)], "unchanged.png", { type: "image/png" }),
		]),
		false,
	);
	assert.equal(prepared, 2);
	assert.equal(thumbnails, 1);
	assert.equal(uploaded, 1);
	assert.equal(
		await uploads.upload([
			new File([new Uint8Array(2048)], "large.txt", { type: "text/plain" }),
		]),
		false,
	);
	assert.equal(prepared, 2);
	assert.equal(uploaded, 1);
});

test("a capture received on unlock waits for initial verified materialization", async (t) => {
	const f = await fixture(t, true);
	let uploads = 0;
	assert.equal(get(f.view).selected, null);
	const batch = createUploads(
		f.session,
		f.view,
		{
			upload: async () => {
				uploads++;
				return { id: "ab".repeat(32) };
			},
			checkQuota: quota(),
		},
		f.preferences,
		f.context.signal,
		{ prepare: async ({ file }) => file, thumbnail: async () => null },
	);
	t.after(batch.dispose);
	assert.equal(
		await batch.upload([new File(["pending"], "capture.txt")]),
		true,
	);
	assert.equal(uploads, 1);
	assert.ok(get(f.view).selected);
});

test("files selected during a batch join its queue and each call reports its own files", async (t) => {
	const f = await fixture(t);
	const held = deferred();
	const names: string[] = [];
	const totals: number[] = [];
	const uploads = createUploads(
		f.session,
		f.view,
		{
			upload: async (options) => {
				const name = String(options.attributes.name);
				names.push(name);
				options.onProgress?.(50);
				if (name === "first.txt") {
					await held.promise;
				}
				if (name === "bad.txt") {
					throw new Error("Upload rejected");
				}
				return { id: "ab".repeat(32) };
			},
			checkQuota: quota(),
		},
		f.preferences,
		f.context.signal,
		{ prepare: async ({ file }) => file, thumbnail: async () => null },
	);
	t.after(uploads.dispose);
	const unsubscribe = uploads.subscribe((state) => {
		if (state.progress) {
			totals.push(state.progress.total);
		}
	});
	t.after(unsubscribe);
	const first = uploads.upload([new File(["1"], "first.txt")]);
	while (!names.length) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const second = uploads.upload([new File(["2"], "second.txt")], {
		source_url: "https://example.com/",
	});
	const third = uploads.upload([new File(["3"], "bad.txt")]);
	assert.equal(get(uploads).progress?.total, 3);
	held.resolve();
	assert.deepEqual(await Promise.all([first, second, third]), [
		true,
		true,
		false,
	]);
	assert.deepEqual(names, ["first.txt", "second.txt", "bad.txt"]);
	assert.equal(get(uploads).completed.length, 2);
	assert.equal(get(uploads).failures.length, 1);
	assert.equal(get(uploads).uploading, false);
	assert.equal(totals.at(-1), 3);
	assert.equal(await uploads.upload([new File(["4"], "next.txt")]), true);
	assert.equal(get(uploads).completed.length, 1);
});
