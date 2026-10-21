import assert from "node:assert/strict";
import test from "node:test";
import { createPairingCrypto } from "../src/lib/pairing/crypto.ts";
import { pairingCrypto } from "../src/lib/pairing/service.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";

for (const factory of [createPairingCrypto, pairingCrypto]) {
	test(`${factory.name} authenticates the receiver key and completes all seven phases`, async (t) => {
		const sender = factory();
		const receiver = factory();
		t.after(sender.dispose);
		t.after(receiver.dispose);
		const context =
			"i2nclip/pairing/v1 https://example.test K7MP abcdefghijklmnopqrstuv";
		await sender.senderSetup({ context, secret: "W4TXN9RC" });
		const first = await receiver.receiverStart({ secret: "W4TXN9RC" });
		const second = await sender.senderResponse({ message: first });
		const third = await receiver.receiverFinish({ context, message: second });
		const { privateKey } = await generatePrivateKey();
		const binding = await receiver.bindReceiver({
			publicKey: privateKey.public_key,
		});
		await sender.senderFinish({ message: third });
		assert.deepEqual(
			await sender.verifyReceiverBinding({ message: binding }),
			privateKey.public_key,
		);
		assert.equal(
			await sender.verificationCode(),
			await receiver.verificationCode(),
		);
		await assert.rejects(
			sender.complete({ value: [1] }),
			/Invalid pairing step|Pairing authentication failed/,
		);
		const packet = await sender.transfer({ value: [1, "credential bundle"] });
		assert.deepEqual(await receiver.receive({ message: packet }), [
			1,
			"credential bundle",
		]);
		await assert.rejects(
			receiver.activate(),
			/Invalid pairing step|Pairing authentication failed/,
		);
		const prepared = await receiver.acknowledge();
		await sender.verifyAcknowledgment({ message: prepared });
		const completion = [1, 42, new Uint8Array(32).fill(9)];
		const accepted = await sender.complete({ value: completion });
		assert.deepEqual(
			await receiver.receiveCompletion({ message: accepted }),
			completion,
		);
		await sender.verifyActivation({ message: await receiver.activate() });
		await assert.rejects(
			receiver.activate(),
			/Invalid pairing step|Pairing authentication failed/,
		);
		await assert.rejects(
			sender.complete({ value: completion }),
			/Invalid pairing step|Pairing authentication failed/,
		);
	});
}
