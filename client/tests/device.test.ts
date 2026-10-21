import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { createRecord } from "../src/lib/protocol/chain.ts";
import {
	decodeDevice,
	encodeDevice,
	MAX_CREDENTIAL_BYTES,
} from "../src/lib/protocol/device.ts";
import { sealEpochKeys } from "../src/lib/protocol/epoch-envelope.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import { passwordOpen, passwordSeal } from "../src/lib/protocol/password.ts";
import { createDevice, initialDeviceState } from "./library-fixture.ts";

const random = () => crypto.getRandomValues(new Uint8Array(32));

test("device initialization separates signing and epoch secrets and has deterministic genesis", async () => {
	const first = await createDevice("https://example.test/setup");
	const second = await createDevice("https://example.test");
	assert.equal(first.identity.phase, "registering");
	assert.equal(first.identity.serverUrl, "https://example.test");
	assert.equal(first.identity.head.sequence, 1);
	assert.notEqual(first.identity.head.hash, bytesToHex(first.identity.library));
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
	assert.equal(first.encryptionKey.privateKey.extractable, false);
	assert.notDeepEqual(
		first.identity.encryption.secret,
		first.identity.privateKey.seed,
	);
	assert.notDeepEqual(
		first.identity.encryption.secret,
		first.identity.epochs[0]?.[1],
	);
});

test("local credentials preserve historical keys and trusted head within bounds", async () => {
	const device = await createDevice("https://example.test");
	const identity = {
		...device.identity,
		phase: "active" as const,
		registration: null,
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

test("pending rotation binds the retained device, parent, and decryptable epoch secret", async () => {
	const old = await createDevice("https://example.test");
	const state = await initialDeviceState(old.identity);
	const salt = random();
	const secret = random();
	const envelopes = await sealEpochKeys(
		{
			library: state.library,
			sequence: state.sequence + 1,
			previous: state.head,
			epoch: 1,
			nextEpoch: 2,
			salt,
		},
		[...state.devices.values()],
		secret,
	);
	const record = await createRecord(
		{
			library: state.library,
			sequence: state.sequence + 1,
			previous: state.head,
			epoch: 1,
			signer: old.recovery.key.publicKey,
			kind: "rotate",
			effects: [2, salt, envelopes],
		},
		old.recovery.key.privateCryptoKey,
	);
	const pending = {
		...old.identity,
		phase: "active" as const,
		registration: null,
		rotation: { secret, record: record.bytes },
	};
	assert.deepEqual(
		(await decodeDevice(encodeDevice(pending))).identity.rotation,
		pending.rotation,
	);
	await assert.rejects(
		decodeDevice(
			encodeDevice({
				...pending,
				head: { sequence: state.sequence, hash: bytesToHex(random()) },
			}),
		),
		/Pending rotation/,
	);
	await assert.rejects(
		decodeDevice(
			encodeDevice({
				...pending,
				rotation: { ...pending.rotation, secret: random() },
			}),
		),
		/secret/,
	);
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

test("local encryption credentials reject public-key substitution and own their secret buffers", async () => {
	const first = await createDevice("https://example.test");
	const second = await createDevice("https://example.test");
	await assert.rejects(
		decodeDevice(
			encodeDevice({
				...first.identity,
				encryption: {
					secret: first.identity.encryption.secret,
					publicKey: second.identity.encryption.publicKey,
				},
			}),
		),
	);
	const bytes = encodeDevice(first.identity);
	const loaded = await decodeDevice(bytes);
	bytes.fill(0);
	assert.deepEqual(
		loaded.identity.encryption.secret,
		first.identity.encryption.secret,
	);
	assert.notEqual(
		loaded.identity.encryption.secret,
		first.identity.encryption.secret,
	);
});
