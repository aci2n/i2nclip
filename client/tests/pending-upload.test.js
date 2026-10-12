import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createPendingUpload } from "../src/lib/stores/pending-upload.js";
import { deferred } from "./helpers.js";
import { serviceFixture, until } from "./service-helpers.js";

test("two pending pages observe one service job and cannot submit it twice", async (t) => {
	const transfer = deferred();
	let sends = 0,
		closes = 0;
	const f = await serviceFixture(t, {
		platform: {
			fetchMedia: async () =>
				new Response("bytes", { headers: { "content-type": "text/plain" } }),
		},
		upload: () => {
			sends++;
			return transfer.promise;
		},
	});
	await f.engine.contextUpload(
		{ id: "pending", srcUrl: "https://media.example/file.txt" },
		true,
	);
	const a = createPendingUpload(
		f.client,
		{
			close: () => {
				closes++;
			},
		},
		"pending",
	);
	const b = createPendingUpload(
		f.client,
		{
			close: () => {
				closes++;
			},
		},
		"pending",
	);
	t.after(a.dispose);
	t.after(b.dispose);
	await a.ready;
	await until(() => get(a).available);
	await Promise.all([a.send("one"), b.send("two")]);
	await until(() => sends === 1);
	transfer.resolve({ id: "saved" });
	await until(() => get(a).status === "Uploaded.");
	assert.equal(get(b).available, false);
	assert.equal(sends, 1);
	assert(closes >= 1);
});

test("missing pending jobs finish loading and tag drafts remain local", async (t) => {
	const f = await serviceFixture(t);
	const pending = createPendingUpload(f.client, { close() {} }, "missing");
	t.after(pending.dispose);
	await pending.ready;
	assert.equal(get(pending).status, "Nothing to upload.");
	pending.tags.set("draft");
	await f.client.command("identity.reset");
	assert.equal(get(pending.tags), "draft");
	assert.equal(get(pending).available, false);
});
