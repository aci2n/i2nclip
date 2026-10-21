import assert from "node:assert/strict";
import test from "node:test";
import { decode } from "../src/lib/protocol/msgpack.ts";
import { createPairingCrypto } from "../src/lib/services/pairing-crypto.ts";
import { pairingRelay } from "../src/lib/services/pairing-relay.ts";
import { deferred, testKey, tick } from "./helpers.ts";
import { createIdentity } from "./library-fixture.ts";
import { documentResponse } from "./msgpack-response.ts";

test("isolated pairing adapters complete a verified exchange", async (t) => {
	const sender = createPairingCrypto();
	const receiver = createPairingCrypto();
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
	const identity = await createIdentity("https://clip.example");
	t.after(identity.dispose);
	const checkpoint = {
		sequence: 0,
		hash: Buffer.from(identity.library).toString("hex"),
	};
	const packet = await sender.transfer({ identity, checkpoint });
	const received = await receiver.receive({ message: packet });
	t.after(received.identity.dispose);
	assert.deepEqual(
		received.identity.signing.publicKey,
		identity.signing.publicKey,
	);

	assert.equal(
		await sender.verifyAcknowledgment({
			message: await receiver.acknowledge(),
		}),
		null,
	);
});

test("relay frames keep control messages small and permit only the credential transfer to grow", async (t) => {
	const snapshot = [
		1,
		"K7MP",
		"abcdefghijklmnopqrstuv",
		120,
		0,
		null,
		"s".repeat(43),
	];
	let requests = 0;
	t.mock.method(
		globalThis,
		"fetch",
		async (_url: unknown, options: RequestInit) => {
			requests++;
			const payload = decode(
				new Uint8Array(await new Response(options.body).arrayBuffer()),
			);
			assert.ok(Array.isArray(payload));
			if (payload.length === 1 && payload[0] === 1) {
				return documentResponse(snapshot);
			}
			assert.equal(payload.length, 2);
			return documentResponse([
				1,
				snapshot[1],
				snapshot[2],
				120,
				payload[0],
				payload[1],
				null,
			]);
		},
	);
	const relay = pairingRelay(
		"https://clip.example",
		new AbortController().signal,
	);
	const room = await relay.create(testKey());
	const large = new Uint8Array(1024 * 1024);
	assert.equal((await relay.submit(room, 4, large)).step, 4);
	await assert.rejects(relay.submit(room, 3, new Uint8Array(8193)), /message/);
	await assert.rejects(relay.join("K7MP", new Uint8Array(8193)), /join/);
	assert.equal(requests, 2);
	const invalid = [
		1,
		snapshot[1],
		snapshot[2],
		120,
		3,
		new Uint8Array(8193),
		null,
	];
	t.mock.method(globalThis, "fetch", async () => documentResponse(invalid));
	await assert.rejects(relay.poll(room), /response/);
});
test("pairing crypto adapter serializes calls, rejects disposal immediately and sanitizes failures", async (t) => {
	const worker = createPairingCrypto();
	const pending = worker.senderSetup({
		secret: "W4TXN9RC",
		context: "context",
	});
	const busy = assert.rejects(worker.verificationCode(), /busy/);
	worker.dispose();
	await busy;
	await assert.rejects(pending, { name: "AbortError" });
	await assert.rejects(
		worker.senderSetup({ context: "context", secret: "secret" }),
		{ name: "AbortError" },
	);
	const fresh = createPairingCrypto();
	t.after(fresh.dispose);
	await assert.rejects(
		fresh.senderResponse({
			message: new TextEncoder().encode("private secret"),
		}),
		(error) =>
			(error instanceof Error ? error.message : String(error)) ===
			"Invalid pairing step.",
	);
});
for (const factory of [createPairingCrypto]) {
	test(`${factory.name} stays disposed after key derivation finishes`, async (t) => {
		const sender = factory();
		const receiver = factory();
		t.after(sender.dispose);
		t.after(receiver.dispose);
		const context = "context";
		const secret = "W4TXN9RC";
		await sender.senderSetup({ secret, context });
		const first = await receiver.receiverStart({ secret });
		const second = await sender.senderResponse({ message: first });
		const entered = deferred();
		const result = deferred<ArrayBuffer>();
		t.after(() => result.resolve(new Uint8Array(5).buffer));
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
		const rejected = assert.rejects(finishing, { name: "AbortError" });
		result.resolve(new Uint8Array(5).buffer);
		await rejected;
		await tick();
		await assert.rejects(receiver.verificationCode(), {
			name: "AbortError",
		});
	});
}
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
				: documentResponse([
						snapshot.v,
						snapshot.id,
						snapshot.instance,
						snapshot.remaining_secs,
						snapshot.step,
						snapshot.message,
						snapshot.capability,
					]),
	);
	const relay = pairingRelay(
		"https://clip.example",
		new AbortController().signal,
	);
	const room = await relay.create(testKey());
	assert.deepEqual(room, snapshot);
	assert.equal(await relay.cancel(room), undefined);
});
