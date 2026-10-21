import assert from "node:assert/strict";
import test from "node:test";
import { bytesToB64url } from "../src/lib/protocol/bytes.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import {
	type Direction,
	MAX_PAIRING_PACKET_BYTES,
	openPairing,
	pairingKeys,
	sealPairing,
} from "../src/lib/protocol/pairing.ts";

test("each pairing phase has independent encryption and authenticated context", async () => {
	const keys = await pairingKeys(
		bytesToB64url(crypto.getRandomValues(new Uint8Array(64))),
		"test room",
	);
	const directions: Direction[] = [
		"receiverBinding",
		"transfer",
		"acknowledgment",
		"completion",
		"activation",
	];
	for (const direction of directions) {
		const packet = await sealPairing(keys, "test room", direction, [1, true]);
		assert.deepEqual(await openPairing(keys, "test room", direction, packet), [
			1,
			true,
		]);
		for (const other of directions.filter((other) => other !== direction)) {
			await assert.rejects(openPairing(keys, "test room", other, packet));
		}
		await assert.rejects(openPairing(keys, "another room", direction, packet));
	}
});
test("only credential transfer permits large packets and all frames are canonical arrays", async () => {
	const keys = await pairingKeys(
		bytesToB64url(crypto.getRandomValues(new Uint8Array(64))),
		"test room",
	);
	const value = [1, new Uint8Array(MAX_PAIRING_PACKET_BYTES - 256)];
	const packet = await sealPairing(keys, "test room", "transfer", value);
	assert.ok(packet.length <= MAX_PAIRING_PACKET_BYTES);
	assert.deepEqual(
		await openPairing(keys, "test room", "transfer", packet),
		value,
	);
	await assert.rejects(
		sealPairing(keys, "test room", "completion", value),
		/payload/,
	);
	await assert.rejects(
		sealPairing(
			keys,
			"test room",
			"transfer",
			new Uint8Array(MAX_PAIRING_PACKET_BYTES),
		),
		/payload/,
	);
	await assert.rejects(
		openPairing(
			keys,
			"test room",
			"transfer",
			new Uint8Array(MAX_PAIRING_PACKET_BYTES + 1),
		),
		/payload/,
	);
	const frame = decode(packet) as unknown[];
	await assert.rejects(
		openPairing(
			keys,
			"test room",
			"transfer",
			encode({ v: frame[0], iv: frame[1], ct: frame[2] }),
		),
		/payload/,
	);
	const mutated = packet.slice();
	mutated[mutated.length - 1] ^= 1;
	await assert.rejects(openPairing(keys, "test room", "transfer", mutated));
});
