import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bytesToHex, concat, hexToBytes } from "../src/lib/protocol/bytes.ts";
import {
	createRecord,
	decryptOperation,
	genesis,
	headerValues,
	inventoryDigest,
	MAX_BLOCK_BYTES,
	openObject,
	SIGN_DOMAIN,
	sealObject,
	verifyRecord,
} from "../src/lib/protocol/chain.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";

const vectors = JSON.parse(
	readFileSync(new URL("./chain-vectors.json", import.meta.url), "utf8"),
);
const recoveryVectors = JSON.parse(
	readFileSync(new URL("./recovery-vectors.json", import.meta.url), "utf8"),
);
const bytes = (name: string) => hexToBytes(vectors[name]);
async function signingKey() {
	return crypto.subtle.importKey(
		"pkcs8",
		concat([hexToBytes("302e020100300506032b657004220420"), bytes("seed")]),
		"Ed25519",
		false,
		["sign"],
	);
}
async function resign(body: unknown) {
	const signed = encode(body);
	return encode([
		signed,
		new Uint8Array(
			await crypto.subtle.sign(
				"Ed25519",
				await signingKey(),
				concat([SIGN_DOMAIN, signed]),
			),
		),
	]);
}

test("canonical genesis, block signatures and encryption match shared vectors", async (t) => {
	const root = await genesis(
		hexToBytes(recoveryVectors.recovery_public_key),
		hexToBytes(recoveryVectors.initial_device_public_key),
		hexToBytes(recoveryVectors.epoch_1_salt),
	);
	assert.equal(bytesToHex(root.bytes), recoveryVectors.genesis);
	assert.equal(bytesToHex(root.hash), recoveryVectors.library);
	const record = await verifyRecord(bytes("record"));
	assert.equal(bytesToHex(record.hash), vectors.block_hash);
	assert.equal(bytesToHex(encode(headerValues(record.body))), vectors.header);
	assert.equal(
		bytesToHex(await decryptOperation(record, bytes("epoch_secret"))),
		vectors.plaintext,
	);
	t.mock.method(crypto, "getRandomValues", (target: Uint8Array) => {
		target.fill(target.length === 32 ? 0x11 : 0x22);
		return target;
	});
	const rebuilt = await createRecord(record.body, await signingKey(), {
		secret: bytes("epoch_secret"),
		plaintext: bytes("plaintext"),
	});
	assert.deepEqual(rebuilt.bytes, record.bytes);
	for (const name of ["enrollment"]) {
		const admin = await verifyRecord(bytes(name));
		assert.equal(admin.body.encrypted, null);
		assert.deepEqual(
			(await createRecord(admin.body, await signingKey())).bytes,
			admin.bytes,
		);
	}
});

test("signatures bind every body field and reject noncanonical or oversized records", async () => {
	const wire = decode(bytes("record")) as Uint8Array[];
	const body = decode(wire[0]) as unknown[];
	for (const index of [1, 3, 5, 8, 9, 10]) {
		const changed = [...body];
		const field = new Uint8Array(changed[index] as Uint8Array);
		field[0] ^= 1;
		changed[index] = field;
		await assert.rejects(verifyRecord(encode([encode(changed), wire[1]])));
	}
	for (const index of [2, 4]) {
		const changed = [...body];
		changed[index] = Number(changed[index]) + 1;
		await assert.rejects(verifyRecord(encode([encode(changed), wire[1]])));
	}
	const extra = concat([bytes("record"), new Uint8Array([0])]);
	await assert.rejects(verifyRecord(extra));
	await assert.rejects(verifyRecord(new Uint8Array(MAX_BLOCK_BYTES + 1)));
	// Version 1 encoded as uint8 rather than its canonical positive fixint.
	const signed = concat([
		wire[0].slice(0, 1),
		new Uint8Array([0xcc, 1]),
		wire[0].slice(2),
	]);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"Ed25519",
			await signingKey(),
			concat([SIGN_DOMAIN, signed]),
		),
	);
	await assert.rejects(
		verifyRecord(encode([signed, signature])),
		/Invalid chain record/,
	);
});

test("signed malformed public effects and incompatible kinds are rejected", async () => {
	const body = decode(bytes("signed_body")) as unknown[];
	for (const [index, value] of [
		[0, 2],
		[2, 0],
		[4, -1],
		[6, "unknown"],
		[8, null],
		[7, [["commit", bytes("file"), [bytes("file"), bytes("file")]]]],
		[7, [["publish", bytes("file")]]],
	] as const) {
		const changed = [...body];
		changed[index] = value;
		await assert.rejects(verifyRecord(await resign(changed)));
	}
	const rotation = decode(
		(decode(hexToBytes(recoveryVectors.reset)) as Uint8Array[])[0],
	) as unknown[];
	rotation[10] = new Uint8Array(16);
	await assert.rejects(verifyRecord(await resign(rotation)));
});

test("epoch secrets and authenticated headers bind operation encryption", async () => {
	const record = await verifyRecord(bytes("record"));
	await assert.rejects(decryptOperation(record, new Uint8Array(32)));
	// A legitimate signer cannot move existing ciphertext to another position.
	const body = decode(bytes("signed_body")) as unknown[];
	body[2] = 2;
	const moved = await verifyRecord(await resign(body));
	await assert.rejects(decryptOperation(moved, bytes("epoch_secret")));
});

test("inventory digest canonicalizes order and rejects duplicate objects", async () => {
	const entries = (vectors.inventory_entries as [string, number][]).map(
		([hash, size]) => [hexToBytes(hash), size] as const,
	);
	assert.equal(
		bytesToHex(
			await inventoryDigest(bytes("library"), bytes("file"), entries.reverse()),
		),
		vectors.inventory,
	);
	await assert.rejects(
		inventoryDigest(bytes("library"), bytes("file"), [entries[0], entries[0]]),
	);
});

test("object ciphertext hash and library/file/purpose bindings are authenticated", async (t) => {
	const args = [
		bytes("library"),
		bytes("file"),
		"metadata",
		bytes("object_hash"),
		bytes("object_key"),
		bytes("object"),
	] as const;
	assert.equal(bytesToHex(await openObject(...args)), vectors.object_plaintext);
	await assert.rejects(
		openObject(args[0], args[1], "manifest", args[3], args[4], args[5]),
	);
	await assert.rejects(
		openObject(new Uint8Array(32), args[1], args[2], args[3], args[4], args[5]),
	);
	await assert.rejects(
		openObject(args[0], new Uint8Array(32), args[2], args[3], args[4], args[5]),
	);
	const damaged = bytes("object");
	damaged[damaged.length - 1] ^= 1;
	await assert.rejects(
		openObject(
			...(args.slice(0, 5) as [
				(typeof args)[0],
				(typeof args)[1],
				(typeof args)[2],
				(typeof args)[3],
				(typeof args)[4],
			]),
			damaged,
		),
		/hash mismatch/,
	);
	t.mock.method(crypto, "getRandomValues", (target: Uint8Array) => {
		target.fill(target.length === 32 ? 0x11 : 0x22);
		return target;
	});
	const encrypted = await sealObject(
		args[0],
		args[1],
		args[2],
		bytes("object_plaintext"),
	);
	assert.deepEqual(encrypted.bytes, args[5]);
	assert.deepEqual(encrypted.key, args[4]);
});
