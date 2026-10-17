import assert from "node:assert/strict";
import test from "node:test";
import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import type { SendOptions } from "../src/lib/media/upload.ts";
import { createUploads } from "../src/lib/stores/uploads.ts";
import { assertPresent } from "./assert.ts";
import { deferred, testKey, tick } from "./helpers.ts";

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
		get ready() {
			const value = get(state);
			return value.unlocked && value.configured && !value.busy;
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
		send?: (options: SendOptions) => Promise<{ id: string }>;
		preferences?: Readable<{ compressImages: boolean }>;
	} = {},
) {
	const owner = session();
	let refreshes = 0;
	const uploads = createUploads(owner, {
		onComplete: async () => {
			refreshes++;
		},
		...options,
	});
	t.after(uploads.dispose);
	return { owner, uploads, refreshes: () => refreshes };
}
test("uploads run sequentially, continue after failures, and report failures for manual resubmission", async (t) => {
	const active = deferred();
	const entered = deferred();
	const seen: Array<string> = [];
	let fail = true;
	let oldProgress: ((percent: number) => void) | undefined;
	const f = fixture(t, {
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
	const files = ["first", "bad", "last"].map((name) => new File([], name));
	const uploading = f.uploads.upload(files);
	await entered.promise;
	assert.deepEqual(seen, ["first"]);
	assert.equal(await f.uploads.upload([new File([], "overlap")]), false);
	active.resolve();
	assert.equal(await uploading, false);
	assert.equal(f.refreshes(), 1);
	assert.deepEqual(seen, ["first", "bad", "last"]);
	assert.deepEqual(get(f.uploads).failures, [
		{ name: "bad", error: "network failed" },
	]);
	assertPresent(oldProgress)(99);
	assert.equal(get(f.uploads).progress, null);
	fail = false;
	const resubmitting = f.uploads.upload([new File([], "bad")]);
	assert.deepEqual(get(f.uploads).failures, []);
	assert.equal(await resubmitting, true);
	assert.equal(f.refreshes(), 2);
	assert.deepEqual(seen, ["first", "bad", "last", "bad"]);
	assert.deepEqual(get(f.uploads).failures, []);
});
test("identity changes and disposal abort uploads and suppress late completion and progress", async (t) => {
	for (const end of ["lock", "dispose"]) {
		const pending = deferred<{
			id: string;
		}>();
		let signal: AbortSignal | undefined;
		let progress: ((percent: number) => void) | undefined;
		const f = fixture(t, {
			send: (args) => {
				signal = args.signal;
				progress = args.onProgress;
				return pending.promise;
			},
		});
		f.owner.configure();
		const uploading = f.uploads.upload([new File([], "pending")]);
		if (end === "lock") {
			f.owner.lock();
		} else {
			f.uploads.dispose();
		}
		assert.equal(assertPresent(signal).aborted, true);
		assertPresent(progress)(50);
		pending.resolve({ id: "late" });
		assert.equal(await uploading, false);
		assert.deepEqual(get(f.uploads), {
			uploading: false,
			progress: null,
			failures: [],
			completed: [],
			status: "",
		});
		assert.equal(f.refreshes(), 0);
	}
});
test("a batch snapshots compression preferences and the next batch sees changes", async (t) => {
	const preferences = writable({ compressImages: true });
	const seen: Array<boolean | undefined> = [];
	const f = fixture(t, {
		preferences,
		send: async ({ compressImages }) => {
			seen.push(compressImages);
			preferences.set({ compressImages: false });
			return { id: String(seen.length) };
		},
	});
	f.owner.configure();
	await f.uploads.upload([new File([], "first"), new File([], "second")]);
	await f.uploads.upload([new File([], "third")]);
	assert.deepEqual(seen, [true, true, false]);
});
