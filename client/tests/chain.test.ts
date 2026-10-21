import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bytesToHex, concat, hexToBytes } from "../src/lib/protocol/bytes.ts";
import {
	inventoryDigest,
	openObject,
	SIGN_DOMAIN,
	sealObject,
} from "../src/lib/protocol/chain.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";

const vectors = JSON.parse(
	readFileSync(new URL("./chain-vectors.json", import.meta.url), "utf8"),
);
const _recoveryVectors = JSON.parse(
	readFileSync(new URL("./recovery-vectors.json", import.meta.url), "utf8"),
);
const bytes = (name: string) => hexToBytes(vectors[name]);
async function signingKey(seed = bytes("seed")) {
	return crypto.subtle.importKey(
		"pkcs8",
		concat([hexToBytes("302e020100300506032b657004220420"), seed]),
		"Ed25519",
		false,
		["sign"],
	);
}
async function _resign(body: unknown, seed = bytes("seed")) {
	const signed = encode(body);
	return encode([
		signed,
		new Uint8Array(
			await crypto.subtle.sign(
				"Ed25519",
				await signingKey(seed),
				concat([SIGN_DOMAIN, signed]),
			),
		),
	]);
}

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
