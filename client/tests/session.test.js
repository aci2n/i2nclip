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
	const result = await f.identity.importPairing(args);
	assert.equal(result.outcome, "saved");
	const operation = result.operation;
	let acknowledged = false;
	await result.withIdentity(async (credentials) => {
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

test("duplicate pairing validates keys before resolving and guards acknowledgment in the destination", async (t) => {
	const f = await fixture(t);
	const receiverRepository = memoryRepository({});
	let resolutions = 0;
	const receiver = createIdentity(
		receiverRepository,
		f.config.serverUrl,
		undefined,
		undefined,
		async (options) => {
			resolutions++;
			const operation = f.identity.operation(options);
			return {
				outcome: "existing",
				libraryId: "saved",
				operation,
				withIdentity: (action) => f.identity.withIdentity(operation, action),
			};
		},
	);
	t.after(receiver.dispose);
	await receiver.ready;
	const args = {
		...f.key,
		serverUrl: f.config.serverUrl,
		signal: new AbortController().signal,
	};
	await assert.rejects(
		receiver.importPairing({ ...args, publicKey: "wrong" }),
		/Invalid paired/,
	);
	assert.equal(resolutions, 0);
	const result = await receiver.importPairing(args);
	assert.equal(result.libraryId, "saved");
	assert.deepEqual(await receiverRepository.getConfig(), {});
	await result.withIdentity((credentials) =>
		assert.equal(credentials.privateKey, f.key.privateKey),
	);
	await f.identity.reset();
	await assert.rejects(
		result.withIdentity(() => assert.fail("stale acknowledgment")),
		{ name: "AbortError" },
	);
	result.operation.dispose();
});

test("pairing resolves a duplicate committed between lookup and final save", async (t) => {
	const { ExistingLibraryError } = await import(
		"../src/lib/service/repository.js"
	);
	const f = await fixture(t);
	const repository = memoryRepository({});
	repository.setConfig = async () => {
		throw new ExistingLibraryError("saved");
	};
	let lookups = 0;
	const receiver = createIdentity(
		repository,
		f.config.serverUrl,
		undefined,
		undefined,
		async (options) => {
			if (++lookups === 1) {
				return null;
			}
			const operation = f.identity.operation(options);
			return {
				outcome: "existing",
				libraryId: "saved",
				operation,
				withIdentity: (action) => f.identity.withIdentity(operation, action),
			};
		},
	);
	t.after(receiver.dispose);
	await receiver.ready;
	const result = await receiver.importPairing({
		...f.key,
		serverUrl: f.config.serverUrl,
		signal: new AbortController().signal,
	});
	assert.equal(result.outcome, "existing");
	assert.equal(lookups, 2);
	await result.withIdentity(() => {});
	result.operation.dispose();
});
