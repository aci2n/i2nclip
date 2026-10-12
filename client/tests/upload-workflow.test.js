import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { deferred } from "./helpers.js";
import { serviceFixture, until } from "./service-helpers.js";

test("completed transfer progress cannot overwrite the next service job", async (t) => {
	const transfers = [];
	const f = await serviceFixture(t, {
		upload: (options) => {
			const job = deferred();
			transfers.push({ options, ...job });
			return job.promise;
		},
	});
	await f.client.command("uploads.submit", {
		sources: ["one", "two"].map((name) => ({
			blob: new Blob([name]),
			name,
			preview: null,
		})),
	});
	await until(() => transfers.length === 1);
	transfers[0].resolve({ id: "one" });
	await until(() => transfers.length === 2);
	transfers[1].options.onProgress(25);
	transfers[0].options.onProgress(99);
	await until(() =>
		get(f.client).uploads.some(
			(job) => job.status === "uploading" && job.progress === 25,
		),
	);
	const active = get(f.client).uploads.find(
		(job) => job.status === "uploading",
	);
	assert.equal(active.name, "two");
	assert.equal(active.progress, 25);
	transfers[1].resolve({ id: "two" });
	await until(() =>
		get(f.client).uploads.every((job) => job.status === "completed"),
	);
});

test("web video uploads are accepted before optional thumbnail preparation and survive helper failure", async (t) => {
	let source;
	const f = await serviceFixture(t, {
		upload: async (options) => {
			source = options.source;
			return { id: "video" };
		},
	});
	const accepted = await f.client.command("uploads.submit", {
		sources: [
			{ blob: new Blob(["video"], { type: "video/webm" }), name: "video.webm" },
		],
	});
	assert.equal(accepted.ids.length, 1);
	await until(() => get(f.client).uploads[0].status === "completed");
	assert.equal(source.preview, null);
});

test("late progress from a failed attempt cannot overwrite a retry of the same job", async (t) => {
	const transfers = [];
	const f = await serviceFixture(t, {
		upload: (options) => {
			const job = deferred();
			transfers.push({ options, ...job });
			return job.promise;
		},
	});
	const accepted = await f.client.command("uploads.submit", {
		sources: [{ blob: new Blob(["one"]), name: "one", preview: null }],
	});
	await until(() => transfers.length === 1);
	transfers[0].reject(new Error("offline"));
	await until(() => get(f.client).uploads[0].status === "failed");
	await f.client.command("uploads.retry", { ids: accepted.ids });
	await until(() => transfers.length === 2);
	transfers[1].options.onProgress(25);
	transfers[0].options.onProgress(99);
	await until(() => get(f.client).uploads[0].progress === 25);
	assert.equal(get(f.client).uploads[0].progress, 25);
	transfers[1].resolve({ id: "saved" });
	await until(() => get(f.client).uploads[0].status === "completed");
});
