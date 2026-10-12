import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createServiceClient } from "../src/lib/service/client.js";
import { tick } from "./helpers.js";

function fixture(t) {
	const sent = [];
	let receive;
	const client = createServiceClient(
		() => ({
			send: (message) => sent.push(message),
			listen(fn) {
				receive = fn;
				return () => {};
			},
			disconnect() {},
		}),
		{ browser: null },
	);
	t.after(client.dispose);
	const snapshot = (instanceId = "owner", sequence = 1) =>
		receive({
			type: "snapshot",
			instanceId,
			sequence,
			clientId: "client",
			value: {
				session: { epoch: 1, unlocked: true },
				media: {},
				views: {},
				uploads: [],
				pairing: {},
			},
		});
	snapshot();
	return { client, sent, receive: (message) => receive(message), snapshot };
}

test("a command reply resolves only after preceding state messages have updated projections", async (t) => {
	const f = fixture(t);
	await f.client.ready;
	const result = f.client.command("identity.reset");
	await tick();
	const request = f.sent.at(-1);
	f.receive({
		type: "state",
		instanceId: "owner",
		sequence: 2,
		topic: "session",
		value: { epoch: 2, unlocked: false },
	});
	f.receive({
		type: "reply",
		instanceId: "owner",
		sequence: 3,
		requestId: request.requestId,
		value: true,
	});
	assert.equal(await result, true);
	assert.equal(get(f.client).session.unlocked, false);
});

test("a sequence gap requests resynchronization and duplicates cannot roll back state", async (t) => {
	const f = fixture(t);
	await f.client.ready;
	f.receive({
		type: "state",
		instanceId: "owner",
		sequence: 3,
		topic: "uploads",
		value: ["missed"],
	});
	await tick();
	assert.equal(f.sent.at(-1).name, "snapshot");
	assert.deepEqual(get(f.client).uploads, []);
	f.snapshot("owner", 4);
	f.receive({
		type: "state",
		instanceId: "owner",
		sequence: 3,
		topic: "uploads",
		value: ["obsolete"],
	});
	assert.deepEqual(get(f.client).uploads, []);
	// Settle the resync request, as the actual service would.
	const request = f.sent.at(-1);
	f.receive({
		type: "reply",
		instanceId: "owner",
		sequence: 5,
		requestId: request.requestId,
		value: true,
	});
});

test("a new owner rejects uncertain commands and old replies are ignored", async (t) => {
	const f = fixture(t);
	const command = f.client.command("uploads.submit", { sources: [] });
	const rejected = assert.rejects(command, /may have completed/);
	await tick();
	const old = f.sent.at(-1);
	f.snapshot("replacement");
	await rejected;
	f.receive({
		type: "reply",
		instanceId: "owner",
		sequence: 2,
		requestId: old.requestId,
		value: true,
	});
	assert.equal(get(f.client).instanceId, "replacement");
});

test("pageshow and focus during initial handshake cannot create competing connections", async (t) => {
	const events = new Map();
	let connections = 0,
		receive;
	const client = createServiceClient(
		() => {
			connections++;
			return {
				send() {},
				listen(listener) {
					receive = listener;
					return () => {};
				},
				disconnect() {},
			};
		},
		{
			browser: {
				addEventListener: (name, handler) => events.set(name, handler),
				removeEventListener: (name) => events.delete(name),
			},
		},
	);
	t.after(client.dispose);
	events.get("pageshow")();
	events.get("focus")();
	assert.equal(connections, 1);
	receive({
		type: "snapshot",
		instanceId: "owner",
		sequence: 1,
		clientId: "one",
		value: {
			session: { epoch: 1 },
			uploads: [],
			media: {},
			views: {},
			pairing: {},
		},
	});
	await client.ready;
	assert.equal(get(client).clientId, "one");
});
