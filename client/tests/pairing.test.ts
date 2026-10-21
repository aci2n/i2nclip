import assert from "node:assert/strict";
import test from "node:test";
import { bytesToB64url } from "../src/lib/protocol/bytes.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import {
	formatPairingCode,
	formatVerificationCode,
	openPairing,
	PAIRING_ALPHABET,
	pairingContext,
	pairingKeys,
	pairingOrigin,
	pairingSecret,
	parsePairingCode,
	sealPairing,
} from "../src/lib/protocol/pairing.ts";
import { bytes as binary } from "../src/lib/protocol/value.ts";
import { readPairingResponse } from "../src/lib/services/pairing-relay.ts";

const room = {
	v: 1,
	id: "K7MP",
	instance: "abcdefghijklmnopqrstuv",
	remaining_secs: 120,
	step: 0,
	message: new Uint8Array(),
	capability: "",
};
const origin = "https://clip.example";
const context = pairingContext(origin, room);
test("verification codes preserve all 40 derived bits and match independent HKDF vectors", async () => {
	assert.equal(
		context,
		"i2nclip/pairing/v1 https://clip.example K7MP abcdefghijklmnopqrstuv",
	);
	assert.equal(formatVerificationCode(new Uint8Array(5)), "2222-2222");
	assert.equal(
		formatVerificationCode(new Uint8Array(5).fill(255)),
		"ZZZZ-ZZZZ",
	);
	for (const invalid of [
		new Uint8Array(4),
		new Uint8Array(6),
		[0, 0, 0, 0, 0],
	]) {
		assert.throws(
			() => formatVerificationCode(invalid),
			/Invalid verification/,
		);
	}
	// Generated independently with node:crypto hkdfSync, SHA-256, and info
	// "verification-code". The five-byte outputs are 0d44e1160e,
	// a7f11eafa1, and 5cb7887629 respectively.
	for (const [byte, binding, expected] of [
		[0, context, "3P4G-47JG"],
		[1, context, "NZSK-XDX3"],
		[0, `${context} changed`, "DLVS-JXKB"],
	] as const) {
		const keys = await pairingKeys(
			bytesToB64url(new Uint8Array(32).fill(byte)),
			binding,
		);
		assert.equal(keys.verificationCode, expected);
	}
});
test("pairing codes preserve all eight secret characters and normalize typing", () => {
	assert.equal(PAIRING_ALPHABET.length, 32);
	for (let i = 0; i < 100; i++) {
		const secret = pairingSecret();
		assert.equal(secret.length, 8);
		assert.deepEqual(
			parsePairingCode(formatPairingCode(room.id, secret).toLowerCase()),
			{ id: room.id, secret },
		);
	}
	assert.deepEqual(parsePairingCode(" k7mp w4tx-n9rc "), {
		id: "K7MP",
		secret: "W4TXN9RC",
	});
	for (const code of [
		"K7MP-W4TX",
		"K7MP-W4TX-N9R0",
		"K7MP-W4TX-N9RI",
		"K7MP-W4TX-N9R!",
	]) {
		assert.throws(() => parsePairingCode(code), /12-character/);
	}
	assert.equal(
		pairingOrigin("http://127.0.0.1:8080/path"),
		"http://127.0.0.1:8080",
	);
	assert.throws(() => pairingOrigin("http://clip.example"), /HTTPS/);
	assert.throws(() => pairingContext(origin, { ...room, v: 2 }), /Invalid/);
});

test("transfer encryption rejects tampering, direction swaps, and different rooms", async () => {
	const keys = await pairingKeys(
		bytesToB64url(crypto.getRandomValues(new Uint8Array(64))),
		context,
	);
	const packet = await sealPairing(keys, context, "transfer", {
		identity: "secret",
	});
	await assert.rejects(openPairing(keys, context, "acknowledgment", packet));
	await assert.rejects(
		openPairing(keys, `${context} changed`, "transfer", packet),
	);
	const parsed = decode(packet) as unknown[];
	const ciphertext = binary(parsed[2]);
	ciphertext[0] ^= 1;
	parsed[2] = ciphertext;
	await assert.rejects(openPairing(keys, context, "transfer", encode(parsed)));
	await assert.rejects(
		openPairing(keys, context, "transfer", "x".repeat(8193)),
	);
});
test("relay responses are capped while streaming regardless of Content-Length", async () => {
	let canceled = false;
	const response = new Response(
		new ReadableStream({
			pull(controller) {
				controller.enqueue(new Uint8Array(8192));
			},
			cancel() {
				canceled = true;
			},
		}),
		{ headers: { "content-length": "1" } },
	);
	await assert.rejects(readPairingResponse(response), /too large/);
	assert.equal(canceled, true);
});
