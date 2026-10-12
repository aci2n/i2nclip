import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createIdentity } from "../src/lib/service/identity.js";
import { memoryRepository } from "./service-helpers.js";
const creation = {
	serverUrl: "https://clip.example",
	password: "password123",
	otc: "invitation",
};
function open(t, repository) {
	const identity = createIdentity(repository, creation.serverUrl);
	t.after(identity.dispose);
	return identity;
}

test("lost registration response retries the durable encrypted identity without spending another invitation", async (t) => {
	const repository = memoryRepository();
	let posts = 0,
		publicKey;
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		if (options.method === "POST") {
			posts++;
			publicKey = JSON.parse(options.body).public_key;
			const pending = (await repository.getConfig()).pendingRegistration;
			assert.equal(pending.publicKey, publicKey);
			assert.equal(typeof pending.privateKey, "string");
			assert.equal(pending.password, undefined);
			assert.equal(pending.otc, undefined);
			throw new Error("response lost");
		}
		assert.ok(options.headers.authorization);
		return new Response(null, { status: 204 });
	});
	const first = open(t, repository);
	await assert.rejects(first.create(creation), /encrypted identity is saved/);
	const pending = (await repository.getConfig()).pendingRegistration;
	first.dispose();
	const second = open(t, repository);
	await second.ready;
	await second.create(creation);
	assert.equal(posts, 1);
	assert.equal(get(second).publicKey, publicKey);
	assert.deepEqual(
		(await repository.getConfig()).privateKey,
		pending.privateKey,
	);
	assert.equal(get(second).pendingRegistration, null);
});

test("registration is never sent before the pending identity commits", async (t) => {
	const repository = memoryRepository();
	repository.setConfig = async () => {
		throw new Error("disk full");
	};
	let requests = 0;
	t.mock.method(globalThis, "fetch", () => {
		requests++;
	});
	await assert.rejects(open(t, repository).create(creation), /disk full/);
	assert.equal(requests, 0);
});

test("a final save failure retains pending identity and retry verifies registration", async (t) => {
	const repository = memoryRepository();
	const save = repository.setConfig;
	let fail = true,
		posts = 0;
	repository.setConfig = async (value) => {
		if (value.privateKey && fail) throw new Error("disk full");
		return save(value);
	};
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		if (options.method === "POST") {
			posts++;
			return new Response(null, { status: 204 });
		}
		return new Response(null, { status: 204 });
	});
	const identity = open(t, repository);
	await assert.rejects(identity.create(creation), /disk full/);
	const pending = (await repository.getConfig()).pendingRegistration;
	fail = false;
	await identity.create(creation);
	assert.equal(posts, 1);
	assert.equal(get(identity).publicKey, pending.publicKey);
});

test("pending creation rejects a different server and can be discarded", async (t) => {
	const repository = memoryRepository();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		throw new Error("offline");
	});
	const identity = open(t, repository);
	await assert.rejects(identity.create(creation));
	const before = await repository.getConfig();
	await assert.rejects(
		identity.create({ ...creation, serverUrl: "https://other.example" }),
	);
	await assert.rejects(identity.setServer("https://other.example"));
	assert.equal(calls, 1);
	assert.deepEqual(await repository.getConfig(), before);
	await identity.discardCreation();
	assert.equal(get(identity).pendingRegistration, null);
});
