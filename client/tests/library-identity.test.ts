import assert from "node:assert/strict";
import {
	createCipheriv,
	createPrivateKey,
	createPublicKey,
	hkdfSync,
} from "node:crypto";
import test from "node:test";
import { concat, hexToBytes, utf8 } from "../src/lib/protocol/bytes.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import {
	createLibraryIdentity,
	openLibraryBackup,
	openLocalIdentity,
	openPairingIdentity,
	sealLibraryBackup,
	sealLocalIdentity,
	sealPairingIdentity,
} from "../src/lib/services/library-identity.ts";

const signal = () => new AbortController().signal;
async function aesKey() {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
		"encrypt",
		"decrypt",
	]);
}

test("one seed restores independent native signing and HKDF encryption vectors", async (t) => {
	const seed = new Uint8Array(32).fill(47);
	const native = createPrivateKey({
		key: Buffer.from(
			concat([hexToBytes("302e020100300506032b657004220420"), seed]),
		),
		format: "der",
		type: "pkcs8",
	});
	const publicKey = new Uint8Array(
		createPublicKey(native)
			.export({ format: "der", type: "spki" })
			.subarray(-32),
	);
	const genesis = encode([1, publicKey]);
	const library = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			concat([utf8("i2nclip/chain/genesis/1\n"), genesis]),
		),
	);
	const plaintext = encode([
		1,
		"https://example.test",
		genesis,
		seed,
		[0, library],
	]);
	const password = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
	const purpose = "i2nclip/library-backup/2";
	const iv = new Uint8Array(12).fill(5);
	const cipher = createCipheriv(
		"aes-256-gcm",
		Buffer.from(hkdfSync("sha256", password, new Uint8Array(), purpose, 32)),
		iv,
	);
	cipher.setAAD(utf8(purpose));
	const ciphertext = concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const backup = encode(["i2nclip-library-backup", 2, [1, iv, ciphertext]]);
	plaintext.fill(0);
	const { identity, checkpoint } = await openLibraryBackup(
		backup,
		" 2345-6789-abcd-efgh-jklm-npqr-stuv-wxyz ",
		signal(),
	);
	t.after(identity.dispose);
	assert.deepEqual(identity.signing.publicKey, publicKey);
	const message = utf8("independent signing probe");
	const signature = await crypto.subtle.sign(
		"Ed25519",
		identity.signing.privateCryptoKey,
		message,
	);
	const verify = await crypto.subtle.importKey(
		"raw",
		publicKey,
		"Ed25519",
		false,
		["verify"],
	);
	assert(await crypto.subtle.verify("Ed25519", verify, signature, message));
	assert.equal(identity.signing.privateCryptoKey.extractable, false);
	assert.equal(identity.encryption.extractable, false);
	const root = new Uint8Array(
		hkdfSync(
			"sha256",
			seed,
			utf8("i2nclip"),
			encode(["i2nclip/library-encryption/1", library]),
			32,
		),
	);
	const salt = new Uint8Array(32).fill(9);
	const info = utf8("probe");
	const actual = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		identity.encryption,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const expected = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(hkdfSync("sha256", root, salt, info, 32)),
		"AES-GCM",
		false,
		["encrypt"],
	);
	const params = { name: "AES-GCM", iv: new Uint8Array(12) };
	assert.deepEqual(
		await crypto.subtle.encrypt(params, actual, message),
		await crypto.subtle.encrypt(params, expected, message),
	);
	assert.equal(checkpoint.sequence, 0);
	assert.equal(JSON.stringify(identity).includes('"seed"'), false);
	seed.fill(0);
	root.fill(0);
});

test("local, backup and pairing exports preserve one identity and checkpoint", async (t) => {
	const created = await createLibraryIdentity("https://example.test", signal());
	t.after(created.identity.dispose);
	const head = { sequence: 7, hash: "ab".repeat(32) };
	const key = await aesKey();
	const sealed = await sealLocalIdentity(created.identity, head, key, signal());
	const local = await openLocalIdentity(sealed, key, signal());
	assert(local);
	t.after(local.identity.dispose);
	const backup = await sealLibraryBackup(local.identity, head, signal());
	assert.match(backup.password, /^([2-9A-HJ-NP-Z]{4}-){7}[2-9A-HJ-NP-Z]{4}$/);
	const restored = await openLibraryBackup(
		backup.bytes,
		backup.password,
		signal(),
	);
	t.after(restored.identity.dispose);
	const challenge = new Uint8Array(32).fill(19);
	const packet = await sealPairingIdentity(
		restored.identity,
		head,
		challenge,
		key,
		"context",
		signal(),
	);
	const paired = await openPairingIdentity(packet, key, "context", signal());
	t.after(paired.identity.dispose);
	assert.deepEqual(paired.challenge, challenge);
	assert.deepEqual(paired.checkpoint, head);
	assert.deepEqual(paired.identity.genesis, created.identity.genesis);
	await assert.rejects(
		openPairingIdentity(packet, key, "other context", signal()),
	);
	const ungrouped = await openLibraryBackup(
		backup.bytes,
		backup.password.replaceAll("-", "").toLowerCase(),
		signal(),
	);
	ungrouped.identity.dispose();
	const wrong = backup.password.startsWith("2")
		? `3${backup.password.slice(1)}`
		: `2${backup.password.slice(1)}`;
	await assert.rejects(
		openLibraryBackup(backup.bytes, wrong, signal()),
		/Wrong password/,
	);
	await assert.rejects(
		openLibraryBackup(backup.bytes, "wrong password", signal()),
		/32-character backup password/,
	);
	const version1 = structuredClone(decode(backup.bytes));
	assert(Array.isArray(version1));
	version1[1] = 1;
	await assert.rejects(
		openLibraryBackup(encode(version1), backup.password, signal()),
		/Invalid/,
	);
	const damaged = structuredClone(decode(backup.bytes));
	assert(
		Array.isArray(damaged) &&
			Array.isArray(damaged[2]) &&
			damaged[2][2] instanceof Uint8Array,
	);
	damaged[2][2][0] ^= 1;
	await assert.rejects(
		openLibraryBackup(encode(damaged), backup.password, signal()),
	);
});

test("disposed and cancelled identities cannot export credentials", async () => {
	const opened = await createLibraryIdentity("https://example.test", signal());
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		sealLibraryBackup(opened.identity, opened.checkpoint, controller.signal),
		{ name: "AbortError" },
	);
	opened.identity.dispose();
	opened.identity.dispose();
	assert.throws(
		() => sealLibraryBackup(opened.identity, opened.checkpoint, signal()),
		/credentials/,
	);
});

test("critical seed boundary has only explicitly allowed production importers", async () => {
	const { readdir, readFile } = await import("node:fs/promises");
	const root = new URL("../src/lib/", import.meta.url);
	const allowed = new Set(["stores/session.ts", "services/pairing-crypto.ts"]);
	for (const name of await readdir(root, { recursive: true })) {
		if (!/\.(ts|svelte)$/.test(name)) {
			continue;
		}
		const source = await readFile(new URL(name, root), "utf8");
		if (
			/(?:from\s*|import\s*\()(["'])[^"']*library-identity(?:\.ts)?\1/.test(
				source,
			)
		) {
			assert(allowed.has(name), `Unexpected seed boundary importer: ${name}`);
		}
	}
});
