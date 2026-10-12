import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createPendingUpload } from "../src/lib/stores/pending-upload.js";
import { deferred } from "./helpers.js";
import { serviceFixture, until } from "./service-helpers.js";

test("locked pages hide pending sources and discard previews arriving after locking", async (t) => {
	const reply = deferred();
	let reads = 0;
	const snapshot = {
		connected: true,
		instanceId: "owner",
		session: { ready: true, unlocked: false, epoch: 1 },
		uploads: [{ id: "pending", name: "private.png", status: "awaiting" }],
	};
	const client = {
		...writable(snapshot),
		ready: Promise.resolve(),
		command: async () => {
			reads++;
			return reads === 1
				? reply.promise
				: { blob: new Blob(["image"], { type: "image/png" }) };
		},
	};
	const pending = createPendingUpload(client, { close() {} }, "pending");
	t.after(pending.dispose);
	assert.equal(reads, 0);
	assert.equal(get(pending).name, "");
	assert.equal(get(pending).available, false);
	client.set({ ...snapshot, session: { ...snapshot.session, unlocked: true } });
	assert.equal(reads, 1);
	client.set({ ...snapshot, session: { ...snapshot.session, epoch: 2 } });
	reply.resolve({ blob: new Blob(["image"], { type: "image/png" }) });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(get(pending).preview, "");
	assert.equal(get(pending).name, "");
	client.set({
		...snapshot,
		session: { ...snapshot.session, unlocked: true, epoch: 2 },
	});
	await until(() => Boolean(get(pending).preview));
	assert.equal(reads, 2);
	assert.equal(get(pending).name, "private.png");
	assert.equal(get(pending).available, true);
});

test("two pending pages observe one service job and cannot submit it twice", async (t) => {
	const transfer = deferred();
	let sends = 0;
	let closes = 0;
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

test("missing pending jobs finish loading and invalidation clears private tag drafts", async (t) => {
	const f = await serviceFixture(t);
	const pending = createPendingUpload(f.client, { close() {} }, "missing");
	t.after(pending.dispose);
	await pending.ready;
	assert.equal(get(pending).status, "Nothing to upload.");
	pending.tags.set("draft");
	await f.client.command("identity.reset");
	assert.equal(get(pending.tags), "");
	assert.equal(get(pending).available, false);
});
