import assert from "node:assert/strict";
import test from "node:test";
import * as opaque from "@serenity-kit/opaque";
import type { Writable } from "svelte/store";
import { get, writable } from "svelte/store";
import type { PairingCrypto } from "../src/lib/pairing/crypto.ts";
import { createPairingCrypto } from "../src/lib/pairing/crypto.ts";
import type { JoinedRoom, Room } from "../src/lib/pairing/service.ts";
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
import {
	bytes as binary,
	document,
	string,
} from "../src/lib/protocol/value.ts";
import type { PairingServices } from "../src/lib/stores/pairing.ts";
import { createPairing } from "../src/lib/stores/pairing.ts";
import type {
	SessionState as ActualSessionState,
	PairedIdentity,
} from "../src/lib/stores/session.ts";
import { deferred, testKey, tick } from "./helpers.ts";

type SessionState = ActualSessionState & {
	privateKey: PairedIdentity["private_key"] | "";
	publicKey: string;
};
const sessionSnapshot: SessionState = {
	status: "unlocked",
	serverUrl: "https://clip.example",
	configured: false,
	unlocked: true,
	busy: false,
	signal: new AbortController().signal,
	context: null,
	privateKey: "",
	publicKey: "",
	error: "",
	checking: false,
};
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
	const parsed = document(decode(packet));
	const ciphertext = binary(parsed.ct);
	ciphertext[0] ^= 1;
	parsed.ct = ciphertext;
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
function fixture(
	t: test.TestContext,
	receiverImport?: (
		value: PairedIdentity,
		state: Writable<SessionState>,
	) => Promise<boolean>,
	options: PairingServices & {
		losePoll?: boolean;
		rejectAck?: boolean;
		loseSubmission?: number;
	} = {},
) {
	let snapshot: JoinedRoom;
	let removed = 0;
	let lostSubmission = false;
	let lostPoll = false;
	const transcript: Uint8Array<ArrayBuffer>[] = [];
	const relay = (_server: string, signal: AbortSignal) => ({
		async create() {
			snapshot = { ...room, capability: "s".repeat(43) };
			return { ...snapshot };
		},
		async join(id: string, message: Uint8Array<ArrayBuffer>) {
			assert.equal(id, room.id);
			assert.equal(snapshot.step, 0);
			snapshot = { ...snapshot, step: 1, message };
			transcript.push(message);
			return { ...snapshot, capability: "r".repeat(43) };
		},
		async poll() {
			signal.throwIfAborted();
			if (options.losePoll && !lostPoll) {
				lostPoll = true;
				throw new TypeError("Lost poll response.");
			}
			return { ...snapshot };
		},
		async submit(_room: Room, step: number, message: Uint8Array<ArrayBuffer>) {
			signal.throwIfAborted();
			if (step === 5 && options.rejectAck) {
				throw new Error("Acknowledgment failed.");
			}
			if (snapshot.step >= step) {
				assert.equal(transcript[step - 1], message);
				return { ...snapshot };
			}
			assert.equal(snapshot.step, step - 1);
			transcript.push(message);
			snapshot = { ...snapshot, step, message };
			if (options.loseSubmission === step && !lostSubmission) {
				lostSubmission = true;
				throw new TypeError("Lost submission response.");
			}
			return { ...snapshot };
		},
		async cancel() {
			removed++;
		},
	});
	const crypto = createPairingCrypto;
	const senderState = writable<SessionState>({
		...sessionSnapshot,
		signal: new AbortController().signal,
		configured: true,
	});
	const receiverState = writable<SessionState>({
		...sessionSnapshot,
		signal: new AbortController().signal,
	});
	const session = (state: Writable<SessionState>) => {
		return {
			subscribe: state.subscribe,
			identity() {
				const value = get(state);
				if (!value.unlocked || !value.configured || value.privateKey === "") {
					throw new Error("Missing identity");
				}
				return {
					serverUrl: value.serverUrl,
					privateKey: value.privateKey,
					publicKey: bytesToB64url(value.privateKey.public_key),
					// The in-memory relay does not authenticate create requests.
					key: testKey(),
				};
			},
			async importPairing(value: PairedIdentity) {
				if (receiverImport) {
					return receiverImport(value, state);
				}
				value.signal.throwIfAborted();
				state.set({
					...get(state),
					serverUrl: value.server_url,
					privateKey: value.private_key,
					publicKey: bytesToB64url(value.public_key),
					configured: true,
					signal: new AbortController().signal,
				});
				return true;
			},
		};
	};
	const sender = createPairing(session(senderState), {
		relay,
		crypto,
		pollMs: 1,
		...options,
	});
	const receiver = createPairing(session(receiverState), {
		relay,
		crypto,
		pollMs: 1,
		...options,
	});
	t.after(() => {
		sender.dispose();
		receiver.dispose();
	});
	return {
		sender,
		receiver,
		senderState,
		receiverState,
		transcript,
		removed: () => removed,
	};
}
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert(Date.now() < deadline, "pairing did not reach expected state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
test("pairing requires explicit approval and reports success only after durable save", async (t) => {
	const saving = deferred();
	const f = fixture(t, async (value, state) => {
		await saving.promise;
		value.signal.throwIfAborted();
		state.set({
			...get(state),
			...value,
			privateKey: value.private_key,
			configured: true,
			signal: new AbortController().signal,
		});
		return true;
	});
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	assert.equal(get(f.sender).verificationCode, "");
	f.sender.approve();
	assert.equal(f.transcript.length, 0);
	const receiving = f.receiver.receive(get(f.sender).code, origin);
	await until(() => get(f.sender).approval);
	await until(() => Boolean(get(f.receiver).verificationCode));
	const verification = get(f.sender).verificationCode;
	assert.equal(get(f.receiver).verificationCode, verification);
	assert.equal(get(f.sender).code, "");
	assert.equal(get(f.receiverState).privateKey, "");
	assert.equal(f.transcript.length, 3);
	f.sender.approve();
	await until(() => f.transcript.length === 4);
	assert.equal(get(f.sender).active, true);
	assert(!get(f.sender).status.includes("connected"));
	saving.resolve();
	assert.equal(await receiving, true);
	assert.equal(await sending, true);
	assert.deepEqual(get(f.receiverState).privateKey, key.privateKey);
	assert.equal(get(f.sender).status, "New device connected.");
	assert.equal(get(f.sender).verificationCode, "");
	assert.equal(get(f.receiver).verificationCode, "");
	assert(
		f.transcript.every(
			(message) =>
				!Buffer.from(message).includes(Buffer.from(key.privateKey.seed)) &&
				!Buffer.from(message).includes("new-password") &&
				!Buffer.from(message).includes(verification) &&
				!Buffer.from(message).includes(verification.replace("-", "")),
		),
	);
});
for (const role of ["sender", "receiver"] as const) {
	test(`${role} rejects verification without transferring or retaining a code`, async (t) => {
		const f = fixture(t);
		const key = await generatePrivateKey();
		f.senderState.update((value) => ({ ...value, ...key }));
		const sending = f.sender.send();
		await until(() => Boolean(get(f.sender).code));
		const receiving = f.receiver.receive(get(f.sender).code, origin);
		await until(
			() => get(f.sender).approval && Boolean(get(f.receiver).verificationCode),
		);
		f[role].rejectVerification();
		assert.match(get(f[role]).status, /did not match/);
		assert.equal(get(f[role]).verificationCode, "");
		f.sender.approve();
		// This fixture does not simulate relay deletion; settle the other peer.
		f[role === "sender" ? "receiver" : "sender"].cancel();
		assert.deepEqual(await Promise.all([sending, receiving]), [false, false]);
		assert.equal(f.transcript.length, 3);
		assert.equal(get(f.receiverState).privateKey, "");
		assert.equal(get(f.sender).verificationCode, "");
		assert.equal(get(f.receiver).verificationCode, "");
		assert(f.removed() >= 1);
		const next = f.sender.send();
		assert.equal(get(f.sender).verificationCode, "");
		await until(() => Boolean(get(f.sender).code));
		f.sender.cancel();
		assert.equal(await next, false);
	});
}
test("identity changes cancel authenticated pairing before any identity transfer", async (t) => {
	const f = fixture(t);
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(get(f.sender).code, origin);
	await until(() => get(f.sender).approval);
	get(f.senderState).signal.dispatchEvent(new Event("abort"));
	assert.equal(await sending, false);
	f.receiver.cancel();
	assert.equal(await receiving, false);
	assert.equal(f.transcript.length, 3);
	assert.equal(get(f.receiverState).privateKey, "");
	assert(f.removed() >= 1);
});
test("cancellation during room creation removes a late room without publishing its code", async (t) => {
	const create = deferred<JoinedRoom>();
	const entered = deferred();
	let removed = 0;
	const session = writable<SessionState>({
		...sessionSnapshot,
		signal: new AbortController().signal,
	});
	const testKeyDocument = (await generatePrivateKey()).privateKey;
	const pairing = createPairing(
		{
			subscribe: session.subscribe,
			identity: () => ({
				serverUrl: origin,
				privateKey: testKeyDocument,
				publicKey: "",
				key: testKey(),
			}),
			importPairing: async () => false,
		},
		{
			crypto: createPairingCrypto,
			relay: () => ({
				join: async () => assert.fail("unexpected join"),
				poll: async () => assert.fail("unexpected poll"),
				submit: async () => assert.fail("unexpected submit"),
				create: () => {
					entered.resolve();
					return create.promise;
				},
				cancel: async () => {
					removed++;
				},
			}),
		},
	);
	t.after(pairing.dispose);
	const sending = pairing.send();
	await entered.promise;
	pairing.cancel();
	create.resolve({ ...room, capability: "s".repeat(43) });
	assert.equal(await sending, false);
	await tick();
	assert.equal(removed, 1);
	assert.equal(get(pairing).code, "");
});
test("expired pairing cannot transfer a key even when the relay still offers approval", async (t) => {
	let elapsed = 0;
	const f = fixture(t, undefined, { now: () => elapsed });
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(get(f.sender).code, origin);
	await until(() => get(f.sender).approval);
	elapsed = 120001;
	f.sender.approve();
	assert.equal(await sending, false);
	assert.match(get(f.sender).status, /expired/);
	assert.equal(get(f.sender).verificationCode, "");
	f.receiver.cancel();
	assert.equal(await receiving, false);
	assert.equal(f.transcript.length, 3);
});
test("canceling during receiver save prevents acknowledgment and stale completion", async (t) => {
	const entered = deferred();
	const finish = deferred();
	const f = fixture(
		t,
		async (value: {
			signal: {
				throwIfAborted: () => void;
			};
		}) => {
			entered.resolve();
			await finish.promise;
			value.signal.throwIfAborted();
			assert.fail("canceled import reached storage");
		},
	);
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(get(f.sender).code, origin);
	await until(() => get(f.sender).approval);
	f.sender.approve();
	await entered.promise;
	f.receiver.cancel();
	finish.resolve();
	assert.equal(await receiving, false);
	assert.equal(get(f.receiverState).privateKey, "");
	assert.equal(f.transcript.length, 4);
	f.sender.cancel();
	assert.equal(await sending, false);
});
test("lost acknowledgment preserves the saved library without claiming sender success", async (t) => {
	const f = fixture(t, undefined, { rejectAck: true });
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(get(f.sender).code, origin);
	await until(() => get(f.sender).approval);
	f.sender.approve();
	assert.equal(await receiving, true);
	assert.deepEqual(get(f.receiverState).privateKey, key.privateKey);
	assert.match(
		get(f.receiver).status,
		/Library saved and unlocked, but confirmation failed/,
	);
	assert.equal(get(f.sender).active, true);
	f.sender.cancel();
	assert.equal(await sending, false);
	assert.notEqual(get(f.sender).status, "New device connected.");
});
for (const step of [2, 3, 4, 5]) {
	test(`lost response at step ${step} retries the same message without another authentication attempt`, async (t) => {
		const f = fixture(t, undefined, { loseSubmission: step, losePoll: true });
		const key = await generatePrivateKey();
		f.senderState.update((value) => ({ ...value, ...key }));
		const sending = f.sender.send();
		await until(() => Boolean(get(f.sender).code));
		const receiving = f.receiver.receive(get(f.sender).code, origin);
		await until(() => get(f.sender).approval);
		f.sender.approve();
		assert.equal(await receiving, true);
		assert.equal(await sending, true);
		assert.equal(f.transcript.length, 5);
		assert.deepEqual(get(f.receiverState).privateKey, key.privateKey);
	});
}

test("session invalidation after saving prevents a late acknowledgment", async (t) => {
	const entered = deferred();
	const finish = deferred();
	const f = fixture(t, undefined, {
		crypto: () => {
			const crypto = createPairingCrypto();
			return {
				...crypto,
				async acknowledge() {
					entered.resolve();
					await finish.promise;
					return crypto.acknowledge();
				},
			};
		},
	});
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(get(f.sender).code, origin);
	await until(() => get(f.sender).approval);
	f.sender.approve();
	await entered.promise;
	assert.deepEqual(get(f.receiverState).privateKey, key.privateKey);
	get(f.receiverState).signal.dispatchEvent(new Event("abort"));
	assert.equal(get(f.receiver).active, false);
	assert.match(get(f.receiver).status, /Library or server changed/);
	finish.resolve();
	assert.equal(await receiving, true);
	assert.equal(f.transcript.length, 4);
	assert.equal(get(f.receiver).verificationCode, "");
	f.sender.cancel();
	assert.equal(await sending, false);
});

test("failed receiver import does not acknowledge or report a connection", async (t) => {
	const f = fixture(t, async () => false);
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(get(f.sender).code, origin);
	await until(() => get(f.sender).approval);
	f.sender.approve();
	assert.equal(await receiving, false);
	assert.equal(f.transcript.length, 4);
	assert.equal(get(f.receiverState).configured, false);
	assert.match(get(f.receiver).status, /Could not save/);
	f.sender.cancel();
	assert.equal(await sending, false);
});
