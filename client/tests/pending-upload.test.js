import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createPendingUpload } from "../src/lib/stores/pending-upload.js";

import { deferred, tick } from "./helpers.js";

const credentials = { privateKey: "first", serverUrl: "https://clip.example" };

test("pending uploads keep independent IDs, prevent duplicate sends, and survive failure", async (t) => {
	const state = writable(credentials);
	const session = {
		subscribe: state.subscribe,
		credentials: () => credentials,
	};
	const sources = {
		"upload:one": { name: "one" },
		"upload:two": { name: "two" },
	};
	const platform = {
		session: {
			get: async (key) => ({ [key]: sources[key] }),
			remove: async (key) => {
				delete sources[key];
			},
		},
		notify: async () => {},
		close: () => {},
	};
	const requests = [];
	const api = {
		prepareMedia: async (source) => ({ ...source, blob: new Blob(["file"]) }),
		sendUpload: (source) => {
			const job = deferred();
			requests.push({ ...job, name: source.name });
			return job.promise;
		},
	};
	const one = createPendingUpload(session, platform, "one", api);
	const two = createPendingUpload(session, platform, "two", api);
	t.after(() => {
		one.dispose();
		two.dispose();
	});
	await Promise.all([one.ready, two.ready]);
	const first = one.send("");
	await one.send("");
	assert.equal(requests.length, 1);
	requests[0].reject(new Error("temporary"));
	await first;
	assert.equal(get(one).status, "temporary");
	assert.deepEqual(Object.keys(sources), ["upload:one", "upload:two"]);
	const retry = one.send("");
	const second = two.send("");
	requests[1].resolve();
	requests[2].resolve();
	await Promise.all([retry, second]);
	assert.deepEqual(sources, {});
	assert.deepEqual(
		requests.map((request) => request.name),
		["one", "one", "two"],
	);
});

test("changing sessions during notification cannot close the upload page", async (t) => {
	const state = writable(credentials);
	const notice = deferred();
	let closed = 0;
	const pending = createPendingUpload(
		{ subscribe: state.subscribe, credentials: () => credentials },
		{
			session: {
				get: async () => ({ "upload:one": { name: "one" } }),
				remove: async () => {},
			},
			notify: () => notice.promise,
			close: () => {
				closed++;
			},
		},
		"one",
		{
			prepareMedia: async (source) => ({ ...source, blob: new Blob(["file"]) }),
			sendUpload: async () => {},
		},
	);
	t.after(pending.dispose);
	await pending.ready;
	const send = pending.send("");
	await tick();
	state.set({ ...credentials, serverUrl: "https://other.example" });
	notice.resolve();
	await send;
	assert.equal(closed, 0);
	assert.equal(get(pending).busy, false);
	assert.equal(get(pending).status, "Library changed. Try again.");
});

for (const first of ["source", "unlock"]) {
	test(`automatic popup sends once when ${first} becomes ready first`, async (t) => {
		const state = writable({ ...credentials, privateKey: "", busy: false });
		const preparation = deferred();
		let sends = 0;
		const session = {
			subscribe: state.subscribe,
			credentials: () => get(state),
		};
		const pending = createPendingUpload(
			session,
			{
				session: {
					get: async () => ({ "upload:one": { name: "one" } }),
					remove: async () => {},
				},
				notify: async () => {},
				close() {},
			},
			"one",
			{
				prepareMedia: () => preparation.promise,
				sendUpload: async () => {
					sends++;
					throw new Error("Try again");
				},
			},
			{ auto: true },
		);
		t.after(pending.dispose);
		if (first === "source") {
			preparation.resolve({ name: "one", blob: new Blob(["file"]) });
			await pending.ready;
		}
		state.set({ ...credentials, busy: true });
		await tick();
		assert.equal(sends, 0);
		state.set({ ...credentials, busy: false });
		if (first === "unlock")
			preparation.resolve({ name: "one", blob: new Blob(["file"]) });
		await pending.ready;
		await tick();
		assert.equal(sends, 1);
		state.set({ ...credentials });
		await tick();
		assert.equal(sends, 1);
		assert.equal(get(pending).status, "Try again");
		await pending.send("retry");
		assert.equal(sends, 2);
	});
}

test("old popup completion cannot clear the busy state of a new-library retry", async (t) => {
	const state = writable(credentials);
	const requests = [];
	const pending = createPendingUpload(
		{ subscribe: state.subscribe, credentials: () => get(state) },
		{
			session: {
				get: async () => ({ "upload:one": { name: "one" } }),
				remove: async () => {},
			},
			notify: async () => {},
			close() {},
		},
		"one",
		{
			prepareMedia: async (source) => ({ ...source, blob: new Blob(["file"]) }),
			sendUpload: (_source, _credentials, _platform, _tags, progress) => {
				const job = deferred();
				requests.push({ ...job, progress });
				return job.promise;
			},
		},
	);
	t.after(pending.dispose);
	await pending.ready;
	const old = pending.send("");
	state.set({ ...credentials, privateKey: "second" });
	const retry = pending.send("");
	requests[0].resolve();
	await old;
	requests[0].progress(99);
	assert.equal(get(pending).busy, true);
	assert.equal(get(pending).status, "Uploading…");
	requests[1].resolve();
	await retry;
	requests[1].progress(99);
	assert.equal(get(pending).status, "Uploaded.");
});

test("source preparation completing after disposal cannot allocate a preview", async (t) => {
	const preparation = deferred();
	let created = 0;
	t.mock.method(URL, "createObjectURL", () => {
		created++;
		return "blob:preview";
	});
	const state = writable(credentials);
	const pending = createPendingUpload(
		{ subscribe: state.subscribe },
		{ session: { get: async () => ({ "upload:one": {} }) } },
		"one",
		{ prepareMedia: () => preparation.promise },
	);
	await tick();
	pending.dispose();
	preparation.resolve({
		name: "one",
		blob: new Blob(["file"], { type: "image/png" }),
	});
	await pending.ready;
	assert.equal(created, 0);
});

test("notification failure leaves a successful upload successful", async (t) => {
	const state = writable(credentials);
	let closed = false;
	const pending = createPendingUpload(
		{ subscribe: state.subscribe, credentials: () => credentials },
		{
			session: {
				get: async () => ({ "upload:one": { name: "one" } }),
				remove: async () => {},
			},
			notify: async () => {
				throw new Error("Notifications unavailable");
			},
			close() {
				closed = true;
			},
		},
		"one",
		{
			prepareMedia: async (source) => ({ ...source, blob: new Blob(["file"]) }),
			sendUpload: async () => {},
		},
	);
	t.after(pending.dispose);
	await pending.ready;
	await pending.send("");
	assert.equal(get(pending).status, "Uploaded.");
	assert.equal(get(pending).available, false);
	assert.equal(closed, true);
});

test("changing the library during popup preparation requires explicit submission", async (t) => {
	const state = writable({ ...credentials, ready: true, publicKey: "first" });
	const preparation = deferred();
	let sends = 0;
	const pending = createPendingUpload(
		{ subscribe: state.subscribe, credentials: () => get(state) },
		{
			session: {
				get: async () => ({ "upload:one": { name: "one" } }),
				remove: async () => {},
			},
			notify: async () => {},
			close() {},
		},
		"one",
		{
			prepareMedia: () => preparation.promise,
			sendUpload: async () => {
				sends++;
			},
		},
		{ auto: true },
	);
	t.after(pending.dispose);
	state.set({
		...credentials,
		ready: true,
		serverUrl: "https://other.example",
		publicKey: "first",
	});
	preparation.resolve({ name: "one", blob: new Blob(["file"]) });
	await pending.ready;
	await tick();
	assert.equal(sends, 0);
	assert.equal(get(pending).status, "Library changed. Try again.");
	await pending.send("");
	assert.equal(sends, 1);
});
