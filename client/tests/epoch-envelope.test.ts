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
	type EpochEnvelopeContext,
	generateDeviceEncryptionKey,
	loadDeviceEncryptionKey,
	openEpochKey,
	sealEpochKey,
} from "../src/lib/protocol/epoch-envelope.ts";

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
