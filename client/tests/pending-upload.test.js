import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createPendingUpload } from "../src/lib/stores/pending-upload.js";

const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
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
	await new Promise((resolve) => setImmediate(resolve));
	state.set({ ...credentials, serverUrl: "https://other.example" });
	notice.resolve();
	await send;
	assert.equal(closed, 0);
	assert.equal(get(pending).busy, false);
	assert.equal(get(pending).status, "Library changed. Try again.");
});
