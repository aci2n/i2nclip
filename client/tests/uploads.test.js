import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createUploads } from "../src/lib/stores/uploads.js";
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
	const seen = [];
	let fail = true;
	let oldProgress;
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
	const files = ["first", "bad", "last"].map((name) => ({ name }));
	const uploading = f.uploads.upload(files);
	await entered.promise;
	assert.deepEqual(seen, ["first"]);
	assert.equal(await f.uploads.upload([{ name: "overlap" }]), false);
	active.resolve();
	assert.equal(await uploading, false);
	assert.equal(f.refreshes(), 1);
	assert.deepEqual(seen, ["first", "bad", "last"]);
	assert.deepEqual(get(f.uploads).failures, [
		{ name: "bad", error: "network failed" },
	]);
	oldProgress(99);
	assert.equal(get(f.uploads).progress, null);
	fail = false;
	const resubmitting = f.uploads.upload([{ name: "bad" }]);
	assert.deepEqual(get(f.uploads).failures, []);
	assert.equal(await resubmitting, true);
	assert.equal(f.refreshes(), 2);
	assert.deepEqual(seen, ["first", "bad", "last", "bad"]);
	assert.deepEqual(get(f.uploads).failures, []);
});

test("identity changes and disposal abort uploads and suppress late completion and progress", async (t) => {
	for (const end of ["lock", "dispose"]) {
		const pending = deferred();
		let signal;
		let progress;
		const f = fixture(t, {
			send: (args) => {
				signal = args.signal;
				progress = args.onProgress;
				return pending.promise;
			},
		});
		f.owner.configure();
		const uploading = f.uploads.upload([{ name: "pending" }]);
		if (end === "lock") {
			f.owner.lock();
		} else {
			f.uploads.dispose();
		}
		assert.equal(signal.aborted, true);
		progress(50);
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
