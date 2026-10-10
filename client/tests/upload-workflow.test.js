import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import {
	createUploadTask,
	sendPendingUpload,
} from "../src/lib/media/upload-workflow.js";
import { deferred } from "./helpers.js";

function fixture(t, options = {}) {
	const state = writable({
		privateKey: "key",
		serverUrl: "https://clip.example",
	});
	let subscriptions = 0;
	const session = {
		credentials: () => get(state),
		subscribe(listener) {
			subscriptions++;
			const unsubscribe = state.subscribe(listener);
			return () => {
				subscriptions--;
				unsubscribe();
			};
		},
	};
	const task = createUploadTask({ session, ...options });
	t.after(task.dispose);
	return { task, state, subscriptions: () => subscriptions };
}

test("each transfer stops publishing progress after settlement, while the batch task remains usable", async (t) => {
	const { task } = fixture(t);
	const first = deferred();
	let oldProgress;
	const updates = [];
	const sending = task.send(
		{ onProgress: (percent) => updates.push(percent) },
		({ onProgress }) => {
			oldProgress = onProgress;
			onProgress(10);
			return first.promise;
		},
	);
	first.reject(new Error("temporary"));
	await assert.rejects(sending, /temporary/);
	await task.send(
		{ onProgress: (percent) => updates.push(percent) },
		async ({ onProgress }) => {
			oldProgress(99);
			onProgress(20);
		},
	);
	oldProgress(100);
	assert.deepEqual(updates, [10, 20]);
});

test("a credential change aborts ignored cancellation and invalidates a task only once", async (t) => {
	let invalidated = 0;
	const { task, state, subscriptions } = fixture(t, {
		onInvalidated: () => invalidated++,
	});
	const transfer = deferred();
	const sending = task.send({}, () => transfer.promise);
	state.update((value) => ({ ...value, privateKey: "other" }));
	state.update((value) => ({ ...value, serverUrl: "https://other.example" }));
	assert.equal(task.signal.aborted, true);
	assert.equal(invalidated, 1);
	transfer.resolve();
	await assert.rejects(sending, { name: "AbortError" });
	task.dispose();
	task.dispose();
	assert.equal(subscriptions(), 0);
});

test("owner cancellation covers preparation before transfer and prevents sending", async (t) => {
	const owner = new AbortController();
	const { task } = fixture(t, { signal: owner.signal });
	const preparing = deferred();
	const prepared = preparing.promise.then(() => task.assertCurrent());
	owner.abort();
	preparing.resolve();
	await assert.rejects(prepared, { name: "AbortError" });
	await assert.rejects(
		task.send({}, () => assert.fail("cancelled task must not send")),
		{ name: "AbortError" },
	);
});

test("library changes during pending-ID cleanup suppress completion and notification", async (t) => {
	const { task, state } = fixture(t);
	let removed;
	await assert.rejects(
		sendPendingUpload(
			{
				task,
				id: "one",
				source: {},
				platform: {
					session: {
						remove: async (key) => {
							removed = key;
							state.update((value) => ({ ...value, privateKey: "other" }));
						},
					},
					notify: () => assert.fail("stale completion must not notify"),
				},
				onUploaded: () =>
					assert.fail("stale completion must not publish success"),
			},
			async () => {},
		),
		{ name: "AbortError" },
	);
	assert.equal(removed, "upload:one");
});
