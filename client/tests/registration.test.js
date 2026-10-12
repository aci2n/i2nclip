import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createIdentity } from "../src/lib/service/identity.js";
import { deferred } from "./helpers.js";
import { memoryRepository } from "./service-helpers.js";

const creation = { serverUrl: "https://clip.example", otc: "invitation" };
function open(t, repository) {
	const identity = createIdentity(repository, creation.serverUrl);
	t.after(identity.dispose);
	return identity;
}

test("lost registration replies retain no identity and a new submission generates a fresh key", async (t) => {
	const repository = memoryRepository();
	const keys = [];
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		assert.equal(options.method, "POST");
		keys.push(JSON.parse(options.body).public_key);
		assert.deepEqual(await repository.getConfig(), {});
		if (keys.length === 1) {
			throw new Error("response lost");
		}
		return new Response(null, { status: 204 });
	});
	const identity = open(t, repository);
	await assert.rejects(
		identity.create(creation),
		/invitation may have been used/,
	);
	assert.deepEqual(await repository.getConfig(), {});
	assert.equal(get(identity).configured, false);
	await identity.create(creation);
	assert.equal(keys.length, 2);
	assert.notEqual(keys[0], keys[1]);
	assert.equal(get(identity).publicKey, keys[1]);
});

test("registration completes before the only configuration write", async (t) => {
	const repository = memoryRepository();
	const response = deferred();
	let requested;
	let writes = 0;
	const save = repository.setConfig;
	repository.setConfig = async (value) => {
		writes++;
		assert.ok(value.privateKey);
		await save(value);
	};
	t.mock.method(globalThis, "fetch", async () => {
		requested = true;
		return response.promise;
	});
	const identity = open(t, repository);
	const creating = identity.create(creation);
	while (!requested) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(writes, 0);
	await assert.rejects(identity.create(creation), /busy/);
	response.resolve(new Response(null, { status: 204 }));
	await creating;
	assert.equal(writes, 1);
});

test("final save failure retains no key and reports registration uncertainty", async (t) => {
	const repository = memoryRepository();
	repository.setConfig = async () => {
		throw new Error("disk full");
	};
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(null, { status: 204 }),
	);
	const identity = open(t, repository);
	await assert.rejects(
		identity.create(creation),
		/disk full.*No recovery identity was retained/,
	);
	assert.deepEqual(await repository.getConfig(), {});
	assert.equal(get(identity).privateKey, "");
});

test("invalid creation avoids network and writes; retry can use another server", async (t) => {
	const repository = memoryRepository();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		throw new Error("offline");
	});
	const identity = open(t, repository);
	await assert.rejects(identity.create({ ...creation, otc: "" }), /invitation/);
	await assert.rejects(
		identity.create({
			...creation,
			serverUrl: "https://user:pass@example.com",
		}),
	);
	assert.equal(calls, 0);
	await assert.rejects(identity.create(creation), /offline/);
	await assert.rejects(
		identity.create({ ...creation, serverUrl: "https://other.example" }),
		/offline/,
	);
	assert.equal(calls, 2);
	assert.deepEqual(await repository.getConfig(), {});
});
