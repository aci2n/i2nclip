import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createLibraryRuntime } from "../src/lib/service/runtime.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { deferred, tick } from "./helpers.js";
import { engineClient, memoryRepository, until } from "./service-helpers.js";

async function fixture(t, options = {}) {
	const key = await generatePrivateKey();
	const repository = memoryRepository({
		serverUrl: "https://clip.example",
		publicKey: key.publicKey,
		privateKey: key.privateKey,
		identityGeneration: "identity",
	});
	const engine = createLibraryRuntime({
		repository,
		defaultServerUrl: "https://clip.example",
		api: { list: async () => ({ items: [], next: null }) },
		...options,
	});
	t.after(engine.dispose);
	const first = engineClient(engine),
		second = engineClient(engine);
	t.after(first.dispose);
	t.after(second.dispose);
	await Promise.all([first.ready, second.ready]);
	return { engine, repository, first, second, key };
}

test("one owner broadcasts unlock and reset without exposing private credentials", async (t) => {
	const f = await fixture(t);
	assert.equal(get(f.first).session.unlocked, true);
	assert.equal(get(f.second).session.unlocked, true);
	assert.equal(JSON.stringify(get(f.second)).includes(f.key.privateKey), false);
	assert.equal("privateKey" in get(f.first).session, false);
	const epoch = get(f.second).session.epoch;
	await f.first.command("identity.reset");
	assert.equal(get(f.second).session.configured, false);
	assert(get(f.second).session.epoch > epoch);
	await assert.rejects(f.second.command("view.search", { id: "old", epoch }), {
		name: "AbortError",
	});
	assert.deepEqual(await f.repository.getConfig(), {});
});

test("identity acknowledgment waits for durable commit, including reset queued behind a stalled write", async (t) => {
	const f = await fixture(t);
	const entered = deferred(),
		finish = deferred();
	const save = f.repository.setConfig;
	f.repository.setConfig = async (value) => {
		entered.resolve();
		await finish.promise;
		await save(value);
	};
	const change = f.first.command("identity.setServer", {
		serverUrl: "https://changed.example",
	});
	const rejected = assert.rejects(change, { name: "AbortError" });
	await entered.promise;
	const reset = f.second.command("identity.reset");
	await tick();
	assert.equal(get(f.first).session.unlocked, false);
	finish.resolve();
	await Promise.all([rejected, reset]);
	assert.deepEqual(await f.repository.getConfig(), {});
});

test("independent searches reject stale results and pagination is single flight", async (t) => {
	const calls = [];
	const f = await fixture(t, {
		api: {
			list: (options) => {
				const job = deferred();
				calls.push({ options, ...job });
				return job.promise;
			},
		},
	});
	await f.first.command("view.open", { id: "a" });
	await f.second.command("view.open", { id: "b" });
	await until(() => calls.length === 2);
	const search = f.first.command("view.search", { id: "a", query: "new" });
	await until(() => calls.length === 3);
	calls[2].resolve({ items: [{ id: "new" }], next: "cursor" });
	await search;
	calls[0].resolve({ items: [{ id: "old" }], next: "wrong" });
	calls[1].resolve({ items: [{ id: "other" }], next: null });
	await until(() => get(f.second).views.b.ids.length === 1);
	assert.deepEqual(get(f.first).views.a.ids, ["new"]);
	assert.equal(get(f.second).views.b.query, "");
	const more = f.first.command("view.more", { id: "a" });
	await until(() => calls.length === 4);
	await f.first.command("view.more", { id: "a" });
	assert.equal(calls.length, 4);
	assert.equal(calls[3].options.tags, "new");
	assert.equal(calls[3].options.after, "cursor");
	calls[3].resolve({ items: [{ id: "new" }, { id: "next" }], next: null });
	await more;
	assert.deepEqual(get(f.first).views.a.ids, ["new", "next"]);
});

test("uploads from multiple clients are sequential, survive disconnect, and retry only failed jobs", async (t) => {
	const transfers = [];
	const f = await fixture(t, {
		upload: (options) => {
			const job = deferred();
			transfers.push({ options, ...job });
			return job.promise;
		},
	});
	const source = (name) => ({ blob: new Blob([name]), name, preview: null });
	await f.first.command("uploads.submit", {
		sources: [source("a"), source("b")],
	});
	await f.second.command("uploads.submit", { sources: [source("c")] });
	await until(() => transfers.length === 1);
	f.first.dispose();
	transfers[0].reject(new Error("offline"));
	await until(() => transfers.length === 2);
	transfers[1].resolve({ id: "b" });
	await until(() => transfers.length === 3);
	transfers[2].resolve({ id: "c" });
	await until(
		() =>
			get(f.second).uploads.filter((job) => job.status === "completed")
				.length === 2,
	);
	const failed = get(f.second).uploads.find((job) => job.status === "failed");
	assert.equal((await f.repository.getSource(failed.id)).name, "a");
	await Promise.all([
		f.second.command("uploads.retry", { ids: [failed.id] }),
		f.second.command("uploads.retry", { ids: [failed.id] }),
	]);
	await until(() => transfers.length === 4);
	assert.equal(transfers[3].options.source.name, "a");
	transfers[3].resolve({ id: "a" });
	await until(() =>
		get(f.second).uploads.every((job) => job.status === "completed"),
	);
	assert.equal(await f.repository.getSource(failed.id), undefined);
});

test("runtime activation after vault unlock retains interrupted and queued sources without automatic replay", async (t) => {
	const active = deferred();
	const f = await fixture(t, { upload: () => active.promise });
	await f.first.command("uploads.submit", {
		sources: ["a", "b"].map((name) => ({
			blob: new Blob([name]),
			name,
			preview: null,
		})),
	});
	await until(() =>
		get(f.first).uploads.some((job) => job.status === "uploading"),
	);
	f.engine.dispose();
	const stored = await f.repository.jobs();
	assert.equal(stored.length, 2);
	let uploads = 0;
	const engine = createLibraryRuntime({
		repository: f.repository,
		defaultServerUrl: "https://clip.example",
		upload: async () => {
			uploads++;
		},
	});
	t.after(engine.dispose);
	const client = engineClient(engine);
	t.after(client.dispose);
	await client.ready;
	assert.equal(get(client).session.unlocked, true);
	assert.deepEqual(
		get(client).uploads.map((job) => job.status),
		["interrupted", "paused"],
	);
	await tick();
	assert.equal(uploads, 0);
	assert((await f.repository.getSource(stored[0].id)).blob instanceof Blob);
	active.resolve({ id: "late" });
});

test("reset suppresses late uploads and removes retained sources", async (t) => {
	const active = deferred();
	const f = await fixture(t, { upload: () => active.promise });
	await f.first.command("uploads.submit", {
		sources: [{ blob: new Blob(["a"]), name: "a", preview: null }],
	});
	await until(() =>
		get(f.first).uploads.some((job) => job.status === "uploading"),
	);
	await f.second.command("identity.reset");
	active.resolve({ id: "late" });
	await tick();
	assert.deepEqual(get(f.first).uploads, []);
	assert.deepEqual(await f.repository.jobs(), []);
});

test("a quota failure rejects the affected source but does not stop the remaining batch", async (t) => {
	const f = await fixture(t, { upload: async () => ({ id: "saved" }) });
	const put = f.repository.putJob;
	f.repository.putJob = async (job, source) => {
		if (source?.name === "full") throw new Error("quota exceeded");
		return put(job, source);
	};
	const result = await f.first.command("uploads.submit", {
		sources: ["full", "okay"].map((name) => ({
			blob: new Blob([name]),
			name,
			preview: null,
		})),
	});
	assert.equal(result.ids.length, 1);
	assert.deepEqual(result.failures, [
		{ name: "full", error: "quota exceeded" },
	]);
	await until(() => get(f.first).uploads[0].status === "completed");
});

test("coalesced content requests cancel independently and return content only to requesters", async (t) => {
	const download = deferred();
	let reads = 0;
	let readSignal;
	const f = await fixture(t, {
		api: {
			list: async () => ({ items: [{ id: "file" }], next: null }),
			getContent: ({ signal }) => {
				reads++;
				readSignal = signal;
				return download.promise;
			},
		},
	});
	await f.first.command("view.open", { id: "a" });
	await until(() => get(f.first).media.file);
	const cancel = new AbortController();
	const first = f.first.command(
		"media.content",
		{ id: "file" },
		{ signal: cancel.signal },
	);
	const rejected = assert.rejects(first, { name: "AbortError" });
	const second = f.second.command("media.content", { id: "file" });
	await until(() => reads === 1);
	await tick();
	cancel.abort();
	await rejected;
	assert.equal(readSignal.aborted, false);
	download.resolve(new Uint8Array([1, 2, 3]));
	const result = await second;
	assert.deepEqual(
		new Uint8Array(await result.blob.arrayBuffer()),
		new Uint8Array([1, 2, 3]),
	);
	assert.equal("blob" in get(f.first).media.file, false);
});
