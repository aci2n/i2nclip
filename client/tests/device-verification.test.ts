import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { verifyDevice } from "../src/lib/device-verification.ts";
import { bytesToHex, hexToBytes } from "../src/lib/protocol/bytes.ts";
import { createRecord } from "../src/lib/protocol/chain.ts";
import { decodeDevice, encodeDevice } from "../src/lib/protocol/device.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { createDevice } from "./library-fixture.ts";

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

test("restored-device verification replays membership and cannot trust server admission alone", async (t) => {
	database(t);
	const old = await createDevice("https://example.test");
	const replacement = await createDevice("https://example.test");
	const record = await createRecord(
		{
			library: old.identity.library,
			sequence: old.identity.head.sequence + 1,
			previous: hexToBytes(old.identity.head.hash),
			epoch: 1,
			signer: old.recovery.key.publicKey,
			kind: "rotate",
			effects: [2, replacement.key.publicKey, new Uint8Array(32).fill(12)],
		},
		old.recovery.key.privateCryptoKey,
	);
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const after = new URL(String(input)).searchParams.get("after");
		return new Response(
			encode([
				record.hash,
				record.body.sequence,
				after === bytesToHex(old.identity.library)
					? [old.identity.registration, record.bytes]
					: after === old.identity.head.hash
						? [record.bytes]
						: [],
				null,
			]),
		);
	});
	const signal = new AbortController().signal;
	await assert.rejects(
		verifyDevice(old, old.identity.head, signal),
		/not authorized in the verified chain/,
	);
	const minimum = {
		sequence: record.body.sequence,
		hash: bytesToHex(record.hash),
	};
	const next = await decodeDevice(
		encodeDevice({
			...old.identity,
			privateKey: replacement.identity.privateKey,
			phase: "active",
			registration: null,
			head: minimum,
			epochs: [
				...old.identity.epochs,
				[2, crypto.getRandomValues(new Uint8Array(32))],
			],
		}),
	);
	const state = await verifyDevice(next, minimum, signal);
	assert.equal(state.epoch, 2);
	assert.equal(
		state.devices.get(bytesToHex(replacement.key.publicKey))?.revokedAt,
		null,
	);
	await assert.rejects(
		verifyDevice(
			next,
			{ sequence: minimum.sequence, hash: "00".repeat(32) },
			signal,
		),
		/trusted head/,
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
			effects: [target.key.publicKey],
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
