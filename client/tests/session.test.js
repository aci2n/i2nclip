import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createIdentity } from "../src/lib/service/identity.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { wrapPrivateKey } from "../src/lib/protocol/vault.js";
import { recoveryFile } from "../src/lib/protocol/recovery.js";
import { memoryRepository } from "./service-helpers.js";

async function fixture(t) {
	const key = await generatePrivateKey();
	const config = {
		serverUrl: "https://clip.example",
		wrappedKey: await wrapPrivateKey(key.privateKey, "password123", 1),
		publicKey: key.publicKey,
		identityGeneration: "initial",
	};
	const repository = memoryRepository(config);
	const identity = createIdentity(repository, config.serverUrl);
	t.after(identity.dispose);
	await identity.ready;
	return { identity, repository, key, config };
}

test("owners always reopen locked and validate an unlocked key against saved public identity", async (t) => {
	const f = await fixture(t);
	assert.equal(get(f.identity).privateKey, "");
	await assert.rejects(f.identity.unlock("wrong"));
	await f.identity.unlock("password123");
	assert.equal(get(f.identity).privateKey, f.key.privateKey);
	const next = createIdentity(f.repository, f.config.serverUrl);
	t.after(next.dispose);
	await next.ready;
	assert.equal(get(next).privateKey, "");
	assert.equal((await f.repository.getConfig()).privateKey, undefined);
});

test("recovery export has no plaintext credentials and restoration assigns a new identity generation", async (t) => {
	const f = await fixture(t);
	const backup = await f.identity.backup();
	assert.equal((await backup.text()).includes(f.key.privateKey), false);
	await f.identity.reset();
	await f.identity.restore(backup, "password123");
	assert.equal(get(f.identity).privateKey, f.key.privateKey);
	assert.notEqual(
		get(f.identity).identityGeneration,
		f.config.identityGeneration,
	);
	assert.equal(get(f.identity).pendingRegistration, null);
});

test("fabricated, foreign, disposed and invalidated operation handles cannot authorize pairing", async (t) => {
	const f = await fixture(t);
	await f.identity.unlock("password123");
	const other = createIdentity(f.repository, f.config.serverUrl);
	t.after(other.dispose);
	await other.ready;
	const operation = f.identity.operation();
	for (const handle of [
		{ signal: new AbortController().signal },
		other.operation(),
	])
		await assert.rejects(
			f.identity.withIdentity(handle, () =>
				assert.fail("invalid handle accepted"),
			),
			/Invalid session operation/,
		);
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
	await f.identity.unlock("password123");
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

test("oversized recovery files are rejected before reading", async (t) => {
	const repository = memoryRepository();
	const identity = createIdentity(repository, "https://clip.example");
	t.after(identity.dispose);
	await identity.ready;
	await assert.rejects(
		identity.restore(
			{ size: 16_385, text: () => assert.fail("oversized file read") },
			"password123",
		),
		/Invalid recovery/,
	);
	assert.deepEqual(await repository.getConfig(), {});
});

test("a paired import uses a local password, persists before acknowledgment, and validates the public key", async (t) => {
	const f = await fixture(t);
	await f.identity.reset();
	const args = {
		serverUrl: f.config.serverUrl,
		...f.key,
		password: "new-password",
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
	await assert.rejects(reopened.unlock("password123"));
	await reopened.unlock("new-password");
	assert.equal(get(reopened).privateKey, f.key.privateKey);
	assert.equal(
		recoveryFile(await f.repository.getConfig()).includes("new-password"),
		false,
	);
});
