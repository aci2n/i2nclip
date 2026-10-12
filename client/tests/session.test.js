import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { createIdentity } from "../src/lib/service/identity.js";
import { memoryRepository } from "./service-helpers.js";

async function fixture(t) {
	const key = await generatePrivateKey();
	const config = {
		serverUrl: "https://clip.example",
		privateKey: key.privateKey,
		publicKey: key.publicKey,
		identityGeneration: "initial",
	};
	const repository = memoryRepository(config);
	const identity = createIdentity(repository, config.serverUrl);
	t.after(identity.dispose);
	await identity.ready;
	return { identity, repository, key, config };
}

test("library runtimes receive credentials from an already unlocked repository", async (t) => {
	const f = await fixture(t);
	assert.equal(get(f.identity).privateKey, f.key.privateKey);
	assert.equal((await f.repository.getConfig()).privateKey, f.key.privateKey);
});

test("fabricated, foreign, disposed and invalidated operation handles cannot authorize pairing", async (t) => {
	const f = await fixture(t);
	const other = createIdentity(f.repository, f.config.serverUrl);
	t.after(other.dispose);
	await other.ready;
	const operation = f.identity.operation();
	for (const handle of [
		{ signal: new AbortController().signal },
		other.operation(),
	]) {
		await assert.rejects(
			f.identity.withIdentity(handle, () =>
				assert.fail("invalid handle accepted"),
			),
			/Invalid session operation/,
		);
	}
	operation.dispose();
	await assert.rejects(
		f.identity.withIdentity(operation, () => {}),
		/Invalid session operation/,
	);
	const stale = f.identity.operation();
	await f.identity.reset();
	await assert.rejects(
		f.identity.withIdentity(stale, () => assert.fail("stale handle accepted")),
		{ name: "AbortError" },
	);
});

test("failed configuration writes publish the actual saved server and allow retry", async (t) => {
	const f = await fixture(t);
	const save = f.repository.setConfig;
	f.repository.setConfig = async () => {
		throw new Error("disk full");
	};
	await assert.rejects(
		f.identity.setServer("https://other.example"),
		/disk full/,
	);
	assert.equal(get(f.identity).serverUrl, f.config.serverUrl);
	assert.match(get(f.identity).error, /disk full/);
	f.repository.setConfig = save;
	await f.identity.setServer("https://other.example");
	assert.equal(get(f.identity).serverUrl, "https://other.example");
});

test("a paired import uses the unlocked vault, persists before acknowledgment, and validates the public key", async (t) => {
	const f = await fixture(t);
	await f.identity.reset();
	const args = {
		serverUrl: f.config.serverUrl,
		...f.key,
		signal: new AbortController().signal,
	};
	await assert.rejects(
		f.identity.importPairing({ ...args, publicKey: "wrong" }),
		/Invalid paired/,
	);
	const operation = await f.identity.importPairing(args);
	let acknowledged = false;
	await f.identity.withIdentity(operation, async (credentials) => {
		assert.equal((await f.repository.getConfig()).publicKey, f.key.publicKey);
		assert.equal(credentials.privateKey, f.key.privateKey);
		acknowledged = true;
	});
	assert.equal(acknowledged, true);
	operation.dispose();
	const reopened = createIdentity(f.repository, f.config.serverUrl);
	t.after(reopened.dispose);
	await reopened.ready;

	assert.equal(get(reopened).privateKey, f.key.privateKey);
});
