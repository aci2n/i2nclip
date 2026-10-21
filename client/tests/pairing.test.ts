import assert from "node:assert/strict";
import test from "node:test";
import * as opaque from "@serenity-kit/opaque";
import type { PairingCrypto } from "../src/lib/pairing/crypto.ts";
import { createPairingCrypto } from "../src/lib/pairing/crypto.ts";
import { readPairingResponse } from "../src/lib/pairing/service.ts";
import { bytesToB64url } from "../src/lib/protocol/bytes.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
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
import { bytes as binary, string } from "../src/lib/protocol/value.ts";

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
async function authenticate(
	sender: PairingCrypto,
	receiver: PairingCrypto,
	receiverContext = context,
	secret = "W4TXN9RC",
) {
	await sender.senderSetup({ secret: "W4TXN9RC", context });
	const first = await receiver.receiverStart({ secret });
	const second = await sender.senderResponse({ message: first });
	const third = await receiver.receiverFinish({
		message: second,
		context: receiverContext,
	});
	await sender.senderFinish({ message: third });
	const { privateKey } = await generatePrivateKey();
	await sender.verifyReceiverBinding({
		message: await receiver.bindReceiver({ publicKey: privateKey.public_key }),
	});
}
test("real OPAQUE pairing transfers identity and verifies an encrypted save acknowledgment", async () => {
	const sender = createPairingCrypto();
	const receiver = createPairingCrypto();
	await assert.rejects(sender.verificationCode(), /Invalid pairing step/);
	await assert.rejects(receiver.verificationCode(), /Invalid pairing step/);
	await authenticate(sender, receiver);
	const verification = await sender.verificationCode();
	assert.match(
		verification,
		/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/,
	);
	assert.equal(await receiver.verificationCode(), verification);
	const value = {
		v: 1,
		private_key: { v: 1, seed: new Uint8Array([1, 2, 3]) },
		server_url: origin,
	};
	const packet = await sender.transfer({ value });
	assert(!Buffer.from(packet).includes("identity"));
	assert.deepEqual(await receiver.receive({ message: packet }), value);
	await assert.rejects(
		receiver.receive({ message: packet }),
		/Invalid pairing step/,
	);
	const ack = await receiver.acknowledge();
	assert(!Buffer.from(ack).includes("saved"));
	await sender.verifyAcknowledgment({ message: ack });
	await assert.rejects(sender.verificationCode(), /Invalid pairing step/);
	await assert.rejects(receiver.verificationCode(), /Invalid pairing step/);
	await assert.rejects(sender.transfer({ value }), /Invalid pairing step/);
});
test("wrong secret and altered session bindings cannot complete authentication", async () => {
	for (const [binding, secret] of [
		[context, "W4TXN9RD"],
		[`${context} other-room`, "W4TXN9RC"],
	]) {
		const sender = createPairingCrypto();
		const receiver = createPairingCrypto();
		await assert.rejects(authenticate(sender, receiver, binding, secret));
		await assert.rejects(sender.verificationCode(), /Invalid pairing step/);
		await assert.rejects(receiver.verificationCode(), /Invalid pairing step/);
		await assert.rejects(
			receiver.receiverFinish({ message: new Uint8Array(), context }),
			/Invalid pairing step/,
		);
		await assert.rejects(
			sender.transfer({ value: {} }),
			/Invalid pairing step/,
		);
	}
});
test("separate OPAQUE sessions using the same original secret have different verification codes", async () => {
	const codes: Array<string> = [];
	for (let attempt = 0; attempt < 2; attempt++) {
		const sender = createPairingCrypto();
		const receiver = createPairingCrypto();
		await authenticate(sender, receiver);
		const code = await sender.verificationCode();
		assert.equal(await receiver.verificationCode(), code);
		codes.push(code);
	}
	assert.notEqual(codes[0], codes[1]);
});
test("verification support is authenticated and mixed old/new clients cannot pair", async () => {
	await opaque.ready;
	const identifiers = {
		client: `${context} receiver`,
		server: `${context} sender`,
	};
	const password = "W4TXN9RC";
	const sender = createPairingCrypto();
	await sender.senderSetup({ secret: password, context });
	const legacyLogin = opaque.client.startLogin({ password });
	const response = await sender.senderResponse({
		message: encode(legacyLogin.startLoginRequest),
	});
	const legacyFinish = opaque.client.finishLogin({
		clientLoginState: legacyLogin.clientLoginState,
		loginResponse: string(decode(response)),
		password,
		identifiers,
	});
	assert.equal(legacyFinish, undefined);
	await assert.rejects(sender.verificationCode(), /Invalid pairing step/);
	await assert.rejects(sender.transfer({ value: {} }), /Invalid pairing step/);
	const serverSetup = opaque.server.createSetup();
	const registration = opaque.client.startRegistration({ password });
	const registrationResponse = opaque.server.createRegistrationResponse({
		serverSetup,
		userIdentifier: context,
		registrationRequest: registration.registrationRequest,
	});
	const { registrationRecord } = opaque.client.finishRegistration({
		clientRegistrationState: registration.clientRegistrationState,
		registrationResponse: registrationResponse.registrationResponse,
		password,
		identifiers,
	});
	const receiver = createPairingCrypto();
	const initial = await receiver.receiverStart({ secret: password });
	const legacyResponse = opaque.server.startLogin({
		serverSetup,
		registrationRecord,
		userIdentifier: context,
		startLoginRequest: string(decode(initial)),
		identifiers,
	});
	await assert.rejects(
		receiver.receiverFinish({
			message: encode(legacyResponse.loginResponse),
			context,
		}),
	);
	await assert.rejects(receiver.verificationCode(), /Invalid pairing step/);
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
