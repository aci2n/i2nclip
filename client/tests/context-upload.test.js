import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { serviceFixture, until } from "./service-helpers.js";

test("context sources get distinct durable IDs and with-tags does not automatically upload", async (t) => {
	let sends = 0;
	const opened = [];
	const f = await serviceFixture(t, {
		platform: {
			fetchMedia: async () => new Response("bytes"),
			openUpload: async (...args) => opened.push(args),
		},
		upload: async () => {
			sends++;
			return { id: "saved" };
		},
	});
	await f.engine.contextUpload({ srcUrl: "https://media.example/one" }, true);
	await f.engine.contextUpload({ srcUrl: "https://media.example/two" }, true);
	await until(() => get(f.client).uploads.length === 2);
	assert.equal(new Set(opened.map(([id]) => id)).size, 2);
	assert.equal(sends, 0);
	await until(() => get(f.client).uploads.every((job) => job.name));
	for (const job of get(f.client).uploads)
		assert((await f.repository.getSource(job.id)).blob instanceof Blob);
});

test("failed context uploads retain their source and open a retry page", async (t) => {
	const opened = [],
		notices = [];
	const f = await serviceFixture(t, {
		platform: {
			fetchMedia: async () => new Response("bytes"),
			openUpload: async (...args) => opened.push(args),
			notify: async (message) => notices.push(message),
		},
		upload: async () => {
			throw new Error("offline");
		},
	});
	await f.engine.contextUpload({ srcUrl: "https://media.example/one" }, false);
	await until(() => get(f.client).uploads[0]?.status === "failed");
	await until(() => opened.length === 1);
	const job = get(f.client).uploads[0];
	assert(await f.repository.getSource(job.id));
	assert.equal(opened[0][0], job.id);
	assert.match(notices[0], /offline/);
});

for (const completedFirst of [false, true]) {
	test(`late source capture cannot overwrite ${completedFirst ? "completed" : "uploading"} job state`, async (t) => {
		const { deferred } = await import("./helpers.js");
		const captured = deferred(),
			uploaded = deferred();
		let fetches = 0;
		const f = await serviceFixture(t, {
			platform: {
				fetchMedia: async () =>
					++fetches === 1 ? captured.promise : new Response("bytes"),
			},
			upload: () => uploaded.promise,
		});
		await f.engine.contextUpload(
			{ id: "race", srcUrl: "https://media.example/file.txt" },
			true,
		);
		await until(() => fetches === 1);
		await f.client.command("pending.send", { id: "race", tags: "new" });
		await until(() => get(f.client).uploads[0].status === "uploading");
		if (completedFirst) {
			uploaded.resolve({ id: "saved" });
			await until(() => get(f.client).uploads[0].status === "completed");
		}
		captured.resolve(new Response("late capture"));
		await until(
			() => completedFirst || get(f.client).uploads[0].name === "file.txt",
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(
			get(f.client).uploads[0].status,
			completedFirst ? "completed" : "uploading",
		);
		assert.equal(get(f.client).uploads[0].tags, "new");
		if (!completedFirst) {
			uploaded.resolve({ id: "saved" });
			await until(() => get(f.client).uploads[0].status === "completed");
		}
		assert.equal(await f.repository.getSource("race"), undefined);
	});
}
