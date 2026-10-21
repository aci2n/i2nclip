import type { Checkpoint } from "../chain-storage.ts";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import {
	type Bytes,
	fixedBytes,
	safeInteger,
	sameBytes,
	verifyRecord,
} from "./chain.ts";
import { type DeviceIdentity, decodeDevice, encodeDevice } from "./device.ts";
import { generateDeviceEncryptionKey } from "./epoch-envelope.ts";
import type { PrivateKeyDocument } from "./identity.ts";
import { parseRecoveryGenesis } from "./recovery-key.ts";

/** All signing secrets stay on their generating device. */
export function pairingBundle(
	identity: DeviceIdentity,
	parent: Checkpoint,
	enrollment: Bytes,
) {
	return [
		1,
		identity.serverUrl,
		identity.genesis,
		identity.library,
		identity.epochs,
		[parent.sequence, hexToBytes(parent.hash)],
		enrollment,
	];
}
function invalid(): never {
	throw new Error("Invalid pairing credential bundle.");
}
export async function pairedDevice(
	input: unknown,
	privateKey: PrivateKeyDocument,
	origin: string,
) {
	if (
		!Array.isArray(input) ||
		input.length !== 7 ||
		input[0] !== 1 ||
		input[1] !== origin ||
		!(input[2] instanceof Uint8Array) ||
		!Array.isArray(input[4]) ||
		!Array.isArray(input[5]) ||
		input[5].length !== 2 ||
		!(input[6] instanceof Uint8Array)
	) {
		invalid();
	}
	const genesis = await parseRecoveryGenesis(new Uint8Array(input[2]));
	const library = fixedBytes(input[3]);
	const parent = {
		sequence: safeInteger(input[5][0]),
		hash: fixedBytes(input[5][1]),
	};
	const enrollment = await verifyRecord(new Uint8Array(input[6]));
	const body = enrollment.body;
	if (
		!sameBytes(library, genesis.hash) ||
		body.kind !== "enroll" ||
		body.sequence !== parent.sequence + 1 ||
		!sameBytes(body.previous, parent.hash) ||
		!sameBytes(body.library, library) ||
		!sameBytes(body.effects[0] as Bytes, privateKey.public_key) ||
		body.epoch !== input[4].length ||
		sameBytes(body.signer, genesis.recoveryPublicKey)
	) {
		invalid();
	}
	const encryption = await generateDeviceEncryptionKey();
	const encoded = encodeDevice({
		serverUrl: origin,
		genesis: genesis.bytes,
		library,
		privateKey,
		encryption,
		epochs: input[4] as DeviceIdentity["epochs"],
		head: { sequence: body.sequence, hash: bytesToHex(enrollment.hash) },
		phase: "pairing",
		rotation: null,
	});
	try {
		return await decodeDevice(encoded);
	} finally {
		encoded.fill(0);
		encryption.secret.fill(0);
	}
}
export function acceptedEnrollment(
	input: unknown,
	expected: Checkpoint,
): Checkpoint {
	if (
		!Array.isArray(input) ||
		input.length !== 3 ||
		input[0] !== 1 ||
		safeInteger(input[1], 1) !== expected.sequence ||
		bytesToHex(fixedBytes(input[2])) !== expected.hash
	) {
		invalid();
	}
	return expected;
}
/** The received transfer owns these plaintext key buffers after decryption. */
export function clearReceivedEpochs(input: unknown) {
	if (Array.isArray(input) && Array.isArray(input[4])) {
		for (const pair of input[4]) {
			if (Array.isArray(pair) && pair[1] instanceof Uint8Array) {
				pair[1].fill(0);
			}
		}
	}
}
