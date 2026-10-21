import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { verifyDevice } from "../src/lib/device-verification.ts";
import { bytesToHex, hexToBytes } from "../src/lib/protocol/bytes.ts";
import { createRecord } from "../src/lib/protocol/chain.ts";
import { encodeOperation } from "../src/lib/protocol/chain-state.ts";
import { decodeDevice, encodeDevice } from "../src/lib/protocol/device.ts";
import { sealEpochKeys } from "../src/lib/protocol/epoch-envelope.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { createDevice, initialDeviceState } from "./library-fixture.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
function database(t: test.TestContext) {
	const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
	Object.defineProperty(globalThis, "indexedDB", {
		value: new IDBFactory(),
		configurable: true,
	});
	t.after(() => {
		if (original) {
			Object.defineProperty(globalThis, "indexedDB", original);
		} else {
			Reflect.deleteProperty(globalThis, "indexedDB");
		}
	});
}

test("retained devices derive future keys during verification while server admission cannot authorize an outsider", async (t) => {
	database(t);
	const old = await createDevice("https://example.test");
	const outsider = await createDevice("https://example.test");
	const initial = await initialDeviceState(old.identity);
	const salt = crypto.getRandomValues(new Uint8Array(32));
	const secret = crypto.getRandomValues(new Uint8Array(32));
	const envelopes = await sealEpochKeys(
		{
			library: initial.library,
			sequence: 2,
			previous: initial.head,
			epoch: 1,
			nextEpoch: 2,
			salt,
		},
		[...initial.devices.values()],
		secret,
	);
	const rotation = await createRecord(
		{
			library: initial.library,
			sequence: 2,
			previous: initial.head,
			epoch: 1,
			signer: old.recovery.key.publicKey,
			kind: "rotate",
			effects: [2, salt, envelopes],
		},
		old.recovery.key.privateCryptoKey,
	);
	const id = new Uint8Array(32).fill(7);
	const add = await createRecord(
		{
			library: initial.library,
			sequence: 3,
			previous: rotation.hash,
			epoch: 2,
			signer: old.key.publicKey,
			kind: "data",
			effects: [["publish", id, new Uint8Array(32).fill(9)]],
		},
		old.key.privateCryptoKey,
		{
			secret,
			plaintext: encodeOperation({
				kind: "AddFile",
				id,
				manifest: {
					hash: new Uint8Array(32).fill(1),
					key: new Uint8Array(32).fill(2),
				},
				metadata: {
					hash: new Uint8Array(32).fill(3),
					key: new Uint8Array(32).fill(4),
				},
			}),
		},
	);
	assert(old.identity.registration);
	const records = [
		{ bytes: old.identity.registration, hash: initial.head },
		rotation,
		add,
	];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const after = new URL(String(input)).searchParams.get("after");
		const start =
			after === bytesToHex(initial.library)
				? 0
				: records.findIndex((record) => bytesToHex(record.hash) === after) + 1;
		return new Response(
			encode([
				add.hash,
				3,
				records.slice(start).map((record) => record.bytes),
				null,
			]),
		);
	});
	const signal = new AbortController().signal;
	const verified = await verifyDevice(old, old.identity.head, signal);
	assert.equal(verified.epoch, 2);
	assert.equal(verified.files.size, 1);
	assert.equal(old.identity.epochs.length, 1);
	const minimum = { sequence: 3, hash: bytesToHex(add.hash) };
	const unapproved = await decodeDevice(
		encodeDevice({
			...old.identity,
			privateKey: outsider.identity.privateKey,
			encryption: outsider.identity.encryption,
			phase: "active",
			registration: null,
			head: minimum,
			epochs: [...old.identity.epochs, [2, secret]],
		}),
	);
	await assert.rejects(
		verifyDevice(unapproved, minimum, signal),
		/not authorized/,
	);
	await assert.rejects(
		verifyDevice(old, { sequence: 3, hash: "00".repeat(32) }, signal),
		/trusted head/i,
	);
});

test("a corrupt signed chain never establishes restored authority", async (t) => {
	database(t);
	const device = await createDevice("https://example.test");
	const target = await createDevice("https://example.test");
	const record = await createRecord(
		{
			library: device.identity.library,
			sequence: device.identity.head.sequence + 1,
			previous: hexToBytes(device.identity.head.hash),
			epoch: 1,
			signer: device.key.publicKey,
			kind: "enroll",
			effects: [target.key.publicKey, target.identity.encryption.publicKey],
		},
		device.key.privateCryptoKey,
	);
	const corrupted = record.bytes.slice();
	corrupted[corrupted.length - 1] ^= 1;
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				encode([
					record.hash,
					record.body.sequence,
					[device.identity.registration, corrupted],
					null,
				]),
			),
	);
	await assert.rejects(
		verifyDevice(device, device.identity.head, new AbortController().signal),
	);
});
