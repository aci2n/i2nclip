import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createPairingCrypto } from "../src/lib/pairing/crypto.js";
import { readPairingResponse } from "../src/lib/pairing/service.js";
import { bytesToB64url } from "../src/lib/protocol/bytes.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import {
	formatPairingCode,
	openPairing,
	PAIRING_ALPHABET,
	pairingContext,
	pairingKeys,
	pairingOrigin,
	pairingSecret,
	parsePairingCode,
	sealPairing,
} from "../src/lib/protocol/pairing.js";
import { createPairing } from "../src/lib/stores/pairing.js";
import { deferred, tick } from "./helpers.js";

const room = {
	v: 1,
	id: "K7MP",
	instance: "abcdefghijklmnopqrstuv",
	remaining_secs: 120,
	step: 0,
	message: null,
};
const origin = "https://clip.example";
const context = pairingContext(origin, room);

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
	])
		assert.throws(() => parsePairingCode(code), /12-character/);
	assert.equal(
		pairingOrigin("http://127.0.0.1:8080/path"),
		"http://127.0.0.1:8080",
	);
	assert.throws(() => pairingOrigin("http://clip.example"), /HTTPS/);
	assert.throws(() => pairingContext(origin, { ...room, v: 2 }), /Invalid/);
});

async function authenticate(
	sender,
	receiver,
	receiverContext = context,
	secret = "W4TXN9RC",
) {
	await sender("senderSetup", { secret: "W4TXN9RC", context });
	const first = await receiver("receiverStart", { secret });
	const second = await sender("senderResponse", { message: first });
	const third = await receiver("receiverFinish", {
		message: second,
		context: receiverContext,
	});
	await sender("senderFinish", { message: third });
}

test("real OPAQUE pairing transfers identity and verifies an encrypted save acknowledgment", async () => {
	const sender = createPairingCrypto(),
		receiver = createPairingCrypto();
	await authenticate(sender, receiver);
	const value = { v: 1, privateKey: "identity", serverUrl: origin };
	const packet = await sender("transfer", { value });
	assert(!packet.includes("identity"));
	assert.deepEqual(await receiver("receive", { message: packet }), value);
	await assert.rejects(
		receiver("receive", { message: packet }),
		/Invalid pairing step/,
	);
	const ack = await receiver("acknowledge", {});
	assert(!ack.includes("saved"));
	await sender("verifyAcknowledgment", { message: ack });
	await assert.rejects(sender("transfer", { value }), /Invalid pairing step/);
});

test("wrong secret and altered session bindings cannot complete authentication", async () => {
	for (const [binding, secret] of [
		[context, "W4TXN9RD"],
		[`${context} other-room`, "W4TXN9RC"],
	]) {
		const sender = createPairingCrypto(),
			receiver = createPairingCrypto();
		await assert.rejects(authenticate(sender, receiver, binding, secret));
		await assert.rejects(
			receiver("receiverFinish", { message: "retry", context }),
			/Invalid pairing step/,
		);
		await assert.rejects(
			sender("transfer", { value: {} }),
			/Invalid pairing step/,
		);
	}
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
	const parsed = JSON.parse(packet);
	parsed.ct = `${parsed.ct[0] === "A" ? "B" : "A"}${parsed.ct.slice(1)}`;
	await assert.rejects(
		openPairing(keys, context, "transfer", JSON.stringify(parsed)),
	);
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

function fixture(t, receiverImport, options = {}) {
	let snapshot;
	let removed = 0;
	let lostSubmission = false;
	let lostPoll = false;
	const transcript = [];
	const relay = (_server, signal) => ({
		async create() {
			snapshot = { ...room, capability: "s".repeat(43) };
			return { ...snapshot };
		},
		async join(id, message) {
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
		async submit(_room, step, message) {
			signal.throwIfAborted();
			if (step === 5 && options.rejectAck)
				throw new Error("Acknowledgment failed.");
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
	const worker = () => ({ call: createPairingCrypto(), dispose() {} });
	const senderState = writable({
		serverUrl: origin,
		identityGeneration: "sender",
		wrappedKey: {},
		privateKey: "",
		ready: true,
	});
	const receiverState = writable({ serverUrl: origin, ready: true });
	const session = (state) => ({
		...state,
		credentials: () => get(state),
		async importPairing(value) {
			if (receiverImport) return receiverImport(value, state);
			value.signal.throwIfAborted();
			state.set({
				...get(state),
				serverUrl: value.serverUrl,
				privateKey: value.privateKey,
				publicKey: value.publicKey,
				wrappedKey: {},
				identityGeneration: "receiver",
			});
			return true;
		},
	});
	const sender = createPairing(session(senderState), {
		relay,
		worker,
		pollMs: 1,
		...options,
	});
	const receiver = createPairing(session(receiverState), {
		relay,
		worker,
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

async function until(predicate) {
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
			wrappedKey: {},
			identityGeneration: "receiver",
		});
		return true;
	});
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(
		get(f.sender).code,
		"new-password",
		origin,
	);
	await until(() => get(f.sender).approval);
	assert.equal(get(f.receiverState).privateKey, undefined);
	assert.equal(f.transcript.length, 3);
	f.sender.approve();
	await until(() => f.transcript.length === 4);
	assert.equal(get(f.sender).active, true);
	assert(!get(f.sender).status.includes("connected"));
	saving.resolve();
	assert.equal(await receiving, true);
	assert.equal(await sending, true);
	assert.equal(get(f.receiverState).privateKey, key.privateKey);
	assert.equal(get(f.sender).status, "New device connected.");
	assert(
		f.transcript.every(
			(message) =>
				!message.includes(key.privateKey) && !message.includes("new-password"),
		),
	);
});

test("identity changes cancel authenticated pairing before any identity transfer", async (t) => {
	const f = fixture(t);
	f.senderState.update((value) => ({ ...value, privateKey: "identity" }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(
		get(f.sender).code,
		"new-password",
		origin,
	);
	await until(() => get(f.sender).approval);
	f.senderState.update((value) => ({
		...value,
		identityGeneration: "changed",
	}));
	assert.equal(await sending, false);
	f.receiver.cancel();
	assert.equal(await receiving, false);
	assert.equal(f.transcript.length, 3);
	assert.equal(get(f.receiverState).privateKey, undefined);
	assert(f.removed() >= 1);
});

test("cancellation during room creation removes a late room without publishing its code", async (t) => {
	const create = deferred();
	let removed = 0;
	const session = writable({ serverUrl: origin, privateKey: "identity" });
	const pairing = createPairing(
		{ ...session, credentials: () => get(session) },
		{
			worker: () => ({ call: async () => {}, dispose() {} }),
			relay: () => ({
				create: () => create.promise,
				cancel: async () => {
					removed++;
				},
			}),
		},
	);
	t.after(pairing.dispose);
	const sending = pairing.send();
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
	f.senderState.update((value) => ({ ...value, privateKey: "identity" }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(
		get(f.sender).code,
		"new-password",
		origin,
	);
	await until(() => get(f.sender).approval);
	elapsed = 120_001;
	f.sender.approve();
	assert.equal(await sending, false);
	assert.match(get(f.sender).status, /expired/);
	f.receiver.cancel();
	assert.equal(await receiving, false);
	assert.equal(f.transcript.length, 3);
});

test("canceling during receiver save prevents acknowledgment and stale completion", async (t) => {
	const entered = deferred(),
		finish = deferred();
	const f = fixture(t, async (value) => {
		entered.resolve();
		await finish.promise;
		value.signal.throwIfAborted();
		assert.fail("canceled import reached storage");
	});
	const key = await generatePrivateKey();
	f.senderState.update((value) => ({ ...value, ...key }));
	const sending = f.sender.send();
	await until(() => Boolean(get(f.sender).code));
	const receiving = f.receiver.receive(
		get(f.sender).code,
		"new-password",
		origin,
	);
	await until(() => get(f.sender).approval);
	f.sender.approve();
	await entered.promise;
	f.receiver.cancel();
	finish.resolve();
	assert.equal(await receiving, false);
	assert.equal(get(f.receiverState).privateKey, undefined);
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
	const receiving = f.receiver.receive(
		get(f.sender).code,
		"new-password",
		origin,
	);
	await until(() => get(f.sender).approval);
	f.sender.approve();
	assert.equal(await receiving, false);
	assert.equal(get(f.receiverState).privateKey, key.privateKey);
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
		const receiving = f.receiver.receive(
			get(f.sender).code,
			"new-password",
			origin,
		);
		await until(() => get(f.sender).approval);
		f.sender.approve();
		assert.equal(await receiving, true);
		assert.equal(await sending, true);
		assert.equal(f.transcript.length, 5);
		assert.equal(get(f.receiverState).privateKey, key.privateKey);
	});
}
