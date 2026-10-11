import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { get, writable } from "svelte/store";
import {
	createUploadTask,
	sendPendingUpload,
} from "../src/lib/media/upload-workflow.js";
import { deferred, installUploadLocks, tick } from "./helpers.js";

beforeEach(installUploadLocks);

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

test("a new generation cancels uploads even when the key and server are unchanged", async (t) => {
	const { task, state } = fixture(t);
	const transfer = deferred();
	const sending = task.send({}, () => transfer.promise);
	state.update((value) => ({ ...value, identityGeneration: "restored" }));
	assert.equal(task.signal.aborted, true);
	transfer.resolve();
	await assert.rejects(sending, { name: "AbortError" });
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
						get: async () => ({ "upload:one": {} }),
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

test("pending ID ownership covers preparation, skips competing sends, and rejects stale sources", async (t) => {
	const first = fixture(t).task;
	const second = fixture(t).task;
	const preparation = deferred();
	const stored = { "upload:one": {} };
	let sends = 0,
		notices = 0,
		prepares = 0;
	const platform = {
		session: {
			get: async (key) => ({ [key]: stored[key] }),
			remove: async (key) => {
				delete stored[key];
			},
		},
		notify: async () => notices++,
	};
	const upload = async () => sends++;
	const options = {
		id: "one",
		platform,
		prepareSource: () => {
			prepares++;
			return preparation.promise;
		},
	};
	const sending = sendPendingUpload({ ...options, task: first }, upload);
	await tick();
	assert.equal(
		await sendPendingUpload({ ...options, task: second }, upload),
		"busy",
	);
	assert.equal(prepares, 1);
	preparation.resolve({});
	assert.equal(await sending, "uploaded");
	assert.equal(
		await sendPendingUpload({ ...options, task: second }, upload),
		"missing",
	);
	assert.equal(prepares, 1);
	assert.equal(sends, 1);
	assert.equal(notices, 1);
});

for (const stage of ["preparation", "transfer"]) {
	test(`${stage} failure releases pending ownership for an explicit retry`, async (t) => {
		const { task } = fixture(t);
		let failed = true;
		const failure = () => {
			if (failed) throw new Error("temporary");
			return {};
		};
		const options = {
			task,
			id: "one",
			platform: {
				session: {
					get: async () => ({ "upload:one": {} }),
					remove: async () => {},
				},
				notify: async () => {},
			},
			prepareSource: stage === "preparation" ? failure : async () => ({}),
		};
		const upload = stage === "transfer" ? failure : async () => {};
		await assert.rejects(sendPendingUpload(options, upload), /temporary/);
		failed = false;
		assert.equal(await sendPendingUpload(options, upload), "uploaded");
	});
}

test("cancellation before ownership or during the storage recheck never sends", async (t) => {
	const { task } = fixture(t);
	const read = deferred();
	const options = {
		task,
		id: "one",
		platform: { session: { get: () => read.promise } },
		prepareSource: () => assert.fail("cancelled source must not prepare"),
	};
	const sending = sendPendingUpload(options);
	task.dispose();
	read.resolve({ "upload:one": {} });
	await assert.rejects(sending, { name: "AbortError" });
	await assert.rejects(sendPendingUpload(options), { name: "AbortError" });
});

test("missing Web Locks retains the source and never submits", async (t) => {
	const { task } = fixture(t);
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: undefined,
	});
	await assert.rejects(
		sendPendingUpload({
			task,
			id: "one",
			platform: {
				session: { get: () => assert.fail("must not touch storage") },
			},
		}),
		/Upload coordination is unavailable/,
	);
});

test("successful cleanup releases ownership before notification finishes", async (t) => {
	const first = fixture(t).task;
	const second = fixture(t).task;
	const notice = deferred();
	let pending = {};
	const options = {
		id: "one",
		source: {},
		platform: {
			session: {
				get: async () => ({ "upload:one": pending }),
				remove: async () => {
					pending = undefined;
				},
			},
			notify: () => notice.promise,
		},
	};
	const sending = sendPendingUpload(
		{ ...options, task: first },
		async () => {},
	);
	await tick();
	assert.equal(
		await sendPendingUpload({ ...options, task: second }, () =>
			assert.fail("completed source must not send"),
		),
		"missing",
	);
	notice.resolve();
	assert.equal(await sending, "uploaded");
});
