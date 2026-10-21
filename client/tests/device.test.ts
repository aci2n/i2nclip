import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { createRecord } from "../src/lib/protocol/chain.ts";
import {
	createDevice,
	decodeDevice,
	encodeDevice,
	MAX_CREDENTIAL_BYTES,
} from "../src/lib/protocol/device.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import { passwordOpen, passwordSeal } from "../src/lib/protocol/password.ts";

const random = () => crypto.getRandomValues(new Uint8Array(32));

test("device initialization separates signing and epoch secrets and has deterministic genesis", async () => {
	const first = await createDevice("https://example.test/setup");
	const second = await createDevice("https://example.test");
	assert.equal(first.identity.phase, "registering");
	assert.equal(first.identity.serverUrl, "https://example.test");
	assert.equal(first.identity.head.hash, bytesToHex(first.identity.library));
	assert.notDeepEqual(
		first.identity.privateKey.seed,
		first.identity.epochs[0]?.[1],
	);
	assert.notDeepEqual(
		first.identity.epochs[0]?.[1],
		second.identity.epochs[0]?.[1],
	);
	assert.deepEqual(
		(await decodeDevice(encodeDevice(first.identity))).identity,
		first.identity,
	);
	assert.equal("fileKeyMaterial" in first.key, false);
	assert.equal(first.key.privateCryptoKey.extractable, false);
});

test("local credentials preserve historical keys and trusted head within bounds", async () => {
	const device = await createDevice("https://example.test");
	const identity = {
		...device.identity,
		phase: "active" as const,
		epochs: [...device.identity.epochs, [2, random()] as const],
		head: { sequence: 4, hash: bytesToHex(random()) },
	};
	assert.deepEqual(
		(await decodeDevice(encodeDevice(identity))).identity,
		identity,
	);
	await assert.rejects(
		decodeDevice(new Uint8Array(MAX_CREDENTIAL_BYTES + 1)),
		/size/,
	);
});

test("credential parsing rejects mismatched genesis, duplicate epochs, key substitution and noncompact documents", async () => {
	const device = await createDevice("https://example.test");
	const another = await createDevice("https://example.test");
	const original = decode(encodeDevice(device.identity)) as unknown[];
	for (const [index, value] of [
		[1, "https://example.test/path"],
		[3, random()],
		[4, [device.identity.privateKey.seed, another.key.publicKey]],
		[
			5,
			[
				[1, random()],
				[1, random()],
			],
		],
		[6, [0, random()]],
		[7, "unknown"],
	] as const) {
		const changed = original.slice();
		changed[index] = value;
		await assert.rejects(decodeDevice(encode(changed)));
	}
	await assert.rejects(decodeDevice(encode({ version: 1 })));
	const input = encodeDevice(device.identity);
	const loaded = await decodeDevice(input);
	input.fill(0);
	assert.deepEqual(
		loaded.identity.privateKey.seed,
		device.identity.privateKey.seed,
	);
});

test("local pending rotation credentials bind both devices and the exact old-signed transition", async () => {
	const old = await createDevice("https://example.test");
	const next = await createDevice("https://example.test");
	const record = await createRecord(
		{
			library: old.identity.library,
			sequence: 1,
			previous: old.identity.library,
			epoch: 1,
			signer: old.key.publicKey,
			kind: "rotate",
			effects: [2, next.key.publicKey],
		},
		old.key.privateCryptoKey,
	);
	const pending = {
		...old.identity,
		phase: "active" as const,
		rotation: {
			replacement: next.identity.privateKey,
			secret: random(),
			record: record.bytes,
		},
	};
	const restored = await decodeDevice(encodeDevice(pending));
	assert.deepEqual(restored.identity.rotation, pending.rotation);
	const moved = {
		...pending,
		head: { sequence: 1, hash: bytesToHex(random()) },
	};
	await assert.rejects(decodeDevice(encodeDevice(moved)), /Pending rotation/);
	const swapped = {
		...pending,
		rotation: { ...pending.rotation, replacement: old.identity.privateKey },
	};
	await assert.rejects(decodeDevice(encodeDevice(swapped)), /Pending rotation/);
});

test("password envelopes use compact frames and bind their purpose", async () => {
	const envelope = await passwordSeal(
		new Uint8Array([1, 2, 3]),
		"test password",
		"one",
	);
	assert.equal(Array.isArray(envelope), true);
	assert.deepEqual(
		await passwordOpen(envelope, "test password", "one"),
		new Uint8Array([1, 2, 3]),
	);
	await assert.rejects(
		passwordOpen(envelope, "test password", "two"),
		/Wrong password/,
	);
	await assert.rejects(
		passwordOpen({ v: 1 }, "test password", "one"),
		/Invalid/,
	);
});
