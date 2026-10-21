import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	AEAD_AES_256_GCM,
	CipherSuite,
	KDF_HKDF_SHA256,
	KEM_DHKEM_X25519_HKDF_SHA256,
} from "hpke";
import { hexToBytes } from "../src/lib/protocol/bytes.ts";
import {
	MAX_AUTHORIZED_DEVICES,
	MAX_BLOCK_BYTES,
} from "../src/lib/protocol/chain.ts";
import {
	type EpochEnvelopeContext,
	generateDeviceEncryptionKey,
	loadDeviceEncryptionKey,
	openEpochKey,
	sealEpochKey,
	sealEpochKeys,
	validateEpochEnvelopes,
} from "../src/lib/protocol/epoch-envelope.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";

test("pinned native HPKE suite opens the independent RFC base-mode vector", async () => {
	const vector = JSON.parse(
		readFileSync(new URL("./hpke-vector.json", import.meta.url), "utf8"),
	);
	const suite = new CipherSuite(
		KEM_DHKEM_X25519_HKDF_SHA256,
		KDF_HKDF_SHA256,
		AEAD_AES_256_GCM,
	);
	const key = await suite.DeserializePrivateKey(hexToBytes(vector.skRm));
	const plaintext = await suite.Open(
		{
			privateKey: key,
			publicKey: await suite.DeserializePublicKey(hexToBytes(vector.pkRm)),
		},
		hexToBytes(vector.enc),
		hexToBytes(vector.encryption.ct),
		{
			info: hexToBytes(vector.info),
			aad: hexToBytes(vector.encryption.aad),
		},
	);
	assert.deepEqual(plaintext, hexToBytes(vector.encryption.pt));
});

test("only the recipient can open a context-bound epoch envelope", async () => {
	const device = await generateDeviceEncryptionKey();
	const other = await generateDeviceEncryptionKey();
	const privateKey = await loadDeviceEncryptionKey(device);
	assert.equal(privateKey.privateKey.extractable, false);
	const context: EpochEnvelopeContext = {
		library: new Uint8Array(32).fill(1),
		previous: new Uint8Array(32).fill(2),
		sequence: 7,
		epoch: 2,
		nextEpoch: 3,
		salt: new Uint8Array(32).fill(3),
		recipient: new Uint8Array(32).fill(4),
		encryptionPublicKey: device.publicKey,
	};
	const secret = crypto.getRandomValues(new Uint8Array(32));
	const envelope = await sealEpochKey(context, secret);
	assert.deepEqual(await openEpochKey(context, privateKey, envelope), secret);
	assert.notDeepEqual((await sealEpochKey(context, secret))[1], envelope[1]);
	await assert.rejects(
		openEpochKey(context, await loadDeviceEncryptionKey(other), envelope),
	);
	for (const change of [
		{ library: new Uint8Array(32).fill(9) },
		{ previous: new Uint8Array(32).fill(9) },
		{ sequence: 8 },
		{ epoch: 3, nextEpoch: 4 },
		{ salt: new Uint8Array(32).fill(9) },
		{ recipient: new Uint8Array(32).fill(9) },
		{ encryptionPublicKey: other.publicKey },
	]) {
		await assert.rejects(
			openEpochKey({ ...context, ...change }, privateKey, envelope),
		);
	}
	const corrupted = envelope[2].slice();
	corrupted[0] ^= 1;
	await assert.rejects(
		openEpochKey(context, privateKey, [envelope[0], envelope[1], corrupted]),
	);
	await assert.rejects(
		openEpochKey(context, privateKey, [
			envelope[0],
			new Uint8Array(32),
			envelope[2],
		]),
	);
	await assert.rejects(
		sealEpochKey(
			{ ...context, encryptionPublicKey: new Uint8Array(32) },
			secret,
		),
	);
	await assert.rejects(
		sealEpochKey({ ...context, nextEpoch: 4 }, secret),
		/advance/,
	);
	await assert.rejects(
		loadDeviceEncryptionKey({
			secret: device.secret,
			publicKey: other.publicKey,
		}),
	);
	assert.deepEqual(await openEpochKey(context, privateKey, envelope), secret);
	device.secret.fill(0);
	other.secret.fill(0);
	secret.fill(0);
});

test("rotation envelopes cover exactly the sorted active membership and fit at capacity", async () => {
	const credentials = await Promise.all(
		Array.from({ length: MAX_AUTHORIZED_DEVICES }, () =>
			generateDeviceEncryptionKey(),
		),
	);
	try {
		const devices = credentials.map((device, index) => ({
			publicKey: new Uint8Array(32).fill(index),
			encryptionPublicKey: device.publicKey,
			revokedAt: null,
		}));
		const transition = {
			library: new Uint8Array(32).fill(9),
			previous: new Uint8Array(32).fill(8),
			sequence: Number.MAX_SAFE_INTEGER,
			epoch: 3,
			nextEpoch: 4,
			salt: new Uint8Array(32).fill(7),
		};
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const envelopes = await sealEpochKeys(
			transition,
			devices.slice().reverse(),
			secret,
		);
		assert.equal(envelopes.length, 128);
		assert.deepEqual(validateEpochEnvelopes(envelopes, devices), envelopes);
		const signedBody = encode([
			1,
			transition.library,
			transition.sequence,
			transition.previous,
			transition.epoch,
			new Uint8Array(32),
			"rotate",
			[transition.nextEpoch, transition.salt, envelopes],
			null,
			null,
			null,
		]);
		assert(encode([signedBody, new Uint8Array(64)]).length < MAX_BLOCK_BYTES);
		for (const index of [0, 127]) {
			assert.deepEqual(
				await openEpochKey(
					{
						...transition,
						recipient: devices[index].publicKey,
						encryptionPublicKey: devices[index].encryptionPublicKey,
					},
					await loadDeviceEncryptionKey(credentials[index]),
					envelopes[index],
				),
				secret,
			);
		}
		assert.throws(
			() => validateEpochEnvelopes(envelopes.slice(1), devices),
			/every/,
		);
		assert.throws(
			() => validateEpochEnvelopes(envelopes.slice().reverse(), devices),
			/sorted/,
		);
		assert.throws(
			() =>
				validateEpochEnvelopes([envelopes[1], ...envelopes.slice(1)], devices),
			/sorted/,
		);
		const revoked = devices.map((device, index) => ({
			...device,
			revokedAt: index === 0 ? 1 : null,
		}));
		const next = await sealEpochKeys(transition, revoked, secret);
		assert.equal(next.length, 127);
		assert.deepEqual(next[0][0], devices[1].publicKey);
		assert.throws(() => validateEpochEnvelopes(envelopes, revoked), /every/);
		await assert.rejects(
			sealEpochKeys(
				transition,
				[
					...devices,
					{ ...devices[0], publicKey: new Uint8Array(32).fill(200) },
				],
				secret,
			),
			/count/,
		);
		await assert.rejects(
			sealEpochKeys(transition, [devices[0], devices[0]], secret),
			/Duplicate/,
		);
		assert.deepEqual(await sealEpochKeys(transition, [], secret), []);
		assert.deepEqual(validateEpochEnvelopes([], []), []);
	} finally {
		for (const device of credentials) {
			device.secret.fill(0);
		}
	}
});
