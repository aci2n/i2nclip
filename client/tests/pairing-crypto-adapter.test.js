import assert from "node:assert/strict";
import test from "node:test";
import { pairingCrypto } from "../src/lib/pairing/service.js";

function noNestedWorkers(t) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
	Object.defineProperty(globalThis, "Worker", {
		configurable: true,
		value: undefined,
	});
	t.after(() =>
		previous
			? Object.defineProperty(globalThis, "Worker", previous)
			: delete globalThis.Worker,
	);
}

test("pairing completes with isolated owner crypto when nested Worker is unavailable", async (t) => {
	noNestedWorkers(t);
	const sender = pairingCrypto();
	const receiver = pairingCrypto();
	t.after(sender.dispose);
	t.after(receiver.dispose);
	const context =
		"i2nclip/pairing/v1 https://clip.example K7MP abcdefghijklmnopqrstuv";
	const secret = "W4TXN9RC";
	await sender.call("senderSetup", { secret, context });
	const first = await receiver.call("receiverStart", { secret });
	const second = await sender.call("senderResponse", { message: first });
	const third = await receiver.call("receiverFinish", {
		message: second,
		context,
	});
	await sender.call("senderFinish", { message: third });
	assert.equal(
		await sender.call("verificationCode"),
		await receiver.call("verificationCode"),
	);
	const value = { v: 1, privateKey: "private identity" };
	const packet = await sender.call("transfer", { value });
	assert.deepEqual(await receiver.call("receive", { message: packet }), value);
	assert.equal(
		await sender.call("verifyAcknowledgment", {
			message: await receiver.call("acknowledge"),
		}),
		null,
	);
});

test("owner crypto adapter serializes calls, rejects disposal immediately and sanitizes failures", async (t) => {
	noNestedWorkers(t);
	const worker = pairingCrypto();
	const pending = worker.call("senderSetup", {
		secret: "W4TXN9RC",
		context: "context",
	});
	await assert.rejects(worker.call("verificationCode"), /busy/);
	worker.dispose();
	await assert.rejects(pending, { name: "AbortError" });
	await assert.rejects(worker.call("senderSetup"), { name: "AbortError" });
	const fresh = pairingCrypto();
	t.after(fresh.dispose);
	await assert.rejects(
		fresh.call("private-secret-invalid-action"),
		(error) =>
			error.message === "Pairing authentication failed. Create a new code.",
	);
});
