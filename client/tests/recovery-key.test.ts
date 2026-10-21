import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRecoveryFile } from "../src/lib/protocol/backup.ts";
import { bytesToHex, hexToBytes } from "../src/lib/protocol/bytes.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { passwordSeal } from "../src/lib/protocol/password.ts";
import {
	createLibraryRecovery,
	epochKey,
	loadRecovery,
	openRecoveryFile,
	parseRecoveryGenesis,
	recoveryGenesis,
} from "../src/lib/protocol/recovery-key.ts";

const vectors = JSON.parse(
	readFileSync(new URL("./recovery-vectors.json", import.meta.url), "utf8"),
);
const bytes = (name: string) => hexToBytes(vectors[name]);
const signingKey = () => ({
	v: 1 as const,
	seed: bytes("signing_seed"),
	public_key: bytes("recovery_public_key"),
});

test("recovery derivations match independent native Ed25519 and HKDF vectors", async () => {
	const root = bytes("epoch_derivation_secret");
	const { loadSigningKey } = await import("../src/lib/protocol/crypto.ts");
	const key = await loadSigningKey(signingKey());
	assert.equal(bytesToHex(key.publicKey), vectors.recovery_public_key);
	const signature = await crypto.subtle.sign(
		"Ed25519",
		key.privateCryptoKey,
		bytes("probe"),
	);
	assert.equal(bytesToHex(new Uint8Array(signature)), vectors.signature);
	const genesis = await recoveryGenesis(key.publicKey, bytes("epoch_1_salt"));
	assert.equal(bytesToHex(genesis.bytes), vectors.genesis);
	assert.equal(bytesToHex(genesis.hash), vectors.library);
	for (const epoch of [1, 2]) {
		assert.equal(
			bytesToHex(
				await epochKey(root, genesis.hash, epoch, bytes(`epoch_${epoch}_salt`)),
			),
			vectors[`epoch_${epoch}_key`],
		);
	}
	assert.equal(bytesToHex(root), vectors.epoch_derivation_secret);
	assert.notDeepEqual(
		await epochKey(root, genesis.hash, 2, bytes("epoch_1_salt")),
		bytes("epoch_1_key"),
	);
	assert.equal(key.privateCryptoKey.extractable, false);
});

test("recovery genesis rejects ambiguous authority and noncanonical encodings", async () => {
	const pub = bytes("recovery_public_key");
	await assert.rejects(
		parseRecoveryGenesis(encode([1, pub, pub, bytes("epoch_1_salt"), 1])),
		/Invalid/,
	);
	await assert.rejects(parseRecoveryGenesis(encode([1, pub, 1])), /Invalid/);
	await assert.rejects(
		loadRecovery({
			serverUrl: "https://example.test",
			genesis: bytes("genesis"),
			library: bytes("library"),
			signingKey: { ...signingKey(), seed: new Uint8Array(32) },
			epochDerivationSecret: bytes("epoch_derivation_secret"),
		}),
		/match|crypto/,
	);
});

test("portable recovery requires a separately generated password and preserves root binding", async () => {
	const identity = {
		serverUrl: "https://example.test",
		genesis: bytes("genesis"),
		library: bytes("library"),
		signingKey: signingKey(),
		epochDerivationSecret: bytes("epoch_derivation_secret"),
	};
	const first = await createRecoveryFile(identity);
	const second = await createRecoveryFile(identity);
	assert.match(first.password, /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(first.password, second.password);
	assert.equal(
		Buffer.from(first.bytes).includes(Buffer.from(first.password)),
		false,
	);
	assert.equal(
		Buffer.from(first.bytes).includes(
			Buffer.from(identity.epochDerivationSecret),
		),
		false,
	);
	const restored = await openRecoveryFile(first.bytes, first.password);
	assert.deepEqual(restored.identity, identity);
	await assert.rejects(
		openRecoveryFile(first.bytes, second.password),
		/Wrong password/,
	);
	await assert.rejects(
		openRecoveryFile(new Uint8Array(1024 * 1024 + 1), first.password),
		/limit/,
	);
	restored.identity.epochDerivationSecret.fill(0);
});

test("creation independently generates recoverable signing and epoch secrets", async () => {
	const first = await createLibraryRecovery(
		"https://example.test",
		bytes("initial_device_public_key"),
		bytes("initial_encryption_public_key"),
	);
	const second = await createLibraryRecovery(
		"https://example.test",
		bytes("initial_device_public_key"),
		bytes("initial_encryption_public_key"),
	);
	assert.notDeepEqual(
		first.recovery.identity.signingKey.seed,
		first.recovery.identity.epochDerivationSecret,
	);
	assert.notDeepEqual(
		first.recovery.identity.signingKey.seed,
		second.recovery.identity.signingKey.seed,
	);
	assert.notDeepEqual(
		first.recovery.identity.epochDerivationSecret,
		second.recovery.identity.epochDerivationSecret,
	);
	assert.deepEqual(
		await epochKey(
			first.recovery.identity.epochDerivationSecret,
			first.recovery.identity.library,
			1,
			first.recovery.genesis.epochSalt,
		),
		first.epochKey,
	);
});

test("recovery import rejects missing secrets, wrong purpose and another library", async () => {
	const base = [
		1,
		"https://example.test",
		bytes("genesis"),
		bytes("library"),
		[bytes("signing_seed"), bytes("recovery_public_key")],
		bytes("epoch_derivation_secret"),
	];
	const password = "test export password";
	for (const frame of [
		base.slice(0, 5),
		[...base.slice(0, 5), new Uint8Array(31)],
		[
			...base.slice(0, 4),
			[new Uint8Array(32), bytes("recovery_public_key")],
			base[5],
		],
		[1, base[1], base[2], new Uint8Array(32), base[4], base[5]],
	]) {
		const encrypted = await passwordSeal(
			encode(frame),
			password,
			"i2nclip/library-recovery/1",
		);
		await assert.rejects(
			openRecoveryFile(
				encode(["i2nclip-library-recovery", 1, encrypted]),
				password,
			),
		);
	}
	const encrypted = await passwordSeal(
		encode(base),
		password,
		"i2nclip/device-backup/1",
	);
	await assert.rejects(
		openRecoveryFile(
			encode(["i2nclip-library-recovery", 1, encrypted]),
			password,
		),
	);
	await assert.rejects(
		openRecoveryFile(encode(["i2nclip-device-backup", 1, encrypted]), password),
		/Invalid recovery file/,
	);
});
