import assert from "node:assert/strict";
import test from "node:test";
import { pairingCrypto, pairingRelay } from "../src/lib/pairing/service.ts";
import { deferred, testKey, tick } from "./helpers.ts";
import { documentResponse } from "./msgpack-response.ts";

test("isolated pairing adapters complete a verified exchange", async (t) => {
	const sender = pairingCrypto();
	const receiver = pairingCrypto();
	t.after(sender.dispose);
	t.after(receiver.dispose);
	const context =
		"i2nclip/pairing/v1 https://clip.example K7MP abcdefghijklmnopqrstuv";
	const secret = "W4TXN9RC";
	await sender.senderSetup({ secret, context });
	const first = await receiver.receiverStart({ secret });
	const second = await sender.senderResponse({ message: first });
	const third = await receiver.receiverFinish({
		message: second,
		context,
	});
	await sender.senderFinish({ message: third });
	assert.equal(
		await sender.verificationCode(),
		await receiver.verificationCode(),
	);
	const value = { v: 1, privateKey: "private identity" };
	const packet = await sender.transfer({ value });
	assert.deepEqual(await receiver.receive({ message: packet }), value);
	assert.equal(
		await sender.verifyAcknowledgment({
			message: await receiver.acknowledge(),
		}),
		null,
	);
});
test("pairing crypto adapter serializes calls, rejects disposal immediately and sanitizes failures", async (t) => {
	const worker = pairingCrypto();
	const pending = worker.senderSetup({
		secret: "W4TXN9RC",
		context: "context",
	});
	await assert.rejects(worker.verificationCode(), /busy/);
	worker.dispose();
	await assert.rejects(pending, { name: "AbortError" });
	await assert.rejects(
		worker.senderSetup({ context: "context", secret: "secret" }),
		{ name: "AbortError" },
	);
	const fresh = pairingCrypto();
	t.after(fresh.dispose);
	await assert.rejects(
		fresh.senderResponse({
			message: new TextEncoder().encode("private secret"),
		}),
		(error) =>
			(error instanceof Error ? error.message : String(error)) ===
			"Pairing authentication failed. Create a new code.",
	);
});
test("disposing an adapter rejects while key derivation is still in flight", async (t) => {
	const sender = pairingCrypto();
	const receiver = pairingCrypto();
	t.after(sender.dispose);
	t.after(receiver.dispose);
	const context = "context";
	const secret = "W4TXN9RC";
	await sender.senderSetup({ secret, context });
	const first = await receiver.receiverStart({ secret });
	const second = await sender.senderResponse({ message: first });
	const entered = deferred();
	const result = deferred<ArrayBuffer>();
	t.mock.method(crypto.subtle, "deriveBits", () => {
		entered.resolve();
		return result.promise;
	});
	const finishing = receiver.receiverFinish({
		message: second,
		context,
	});
	await entered.promise;
	receiver.dispose();
	await assert.rejects(finishing, { name: "AbortError" });
	result.resolve(new Uint8Array(5).buffer);
	await tick();
	await assert.rejects(receiver.verificationCode(), {
		name: "AbortError",
	});
});
test("pairing relay accepts a newly created room with no message and cancellation has no document", async (t) => {
	const snapshot = {
		v: 1,
		id: "K7MP",
		instance: "abcdefghijklmnopqrstuv",
		remaining_secs: 120,
		step: 0,
		message: null,
		capability: "s".repeat(43),
	};
	t.mock.method(
		globalThis,
		"fetch",
		async (_url: unknown, options: RequestInit) =>
			options.method === "DELETE"
				? new Response(null, { status: 204 })
				: documentResponse(snapshot),
	);
	const relay = pairingRelay(
		"https://clip.example",
		new AbortController().signal,
	);
	const room = await relay.create(testKey);
	assert.deepEqual(room, snapshot);
	assert.equal(await relay.cancel(room), undefined);
});
