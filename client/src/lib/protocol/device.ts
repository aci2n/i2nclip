import type { Checkpoint } from "../chain-storage.ts";
import { bytesToHex } from "./bytes.ts";
import {
	type Bytes,
	fixedBytes,
	safeInteger,
	sameBytes,
	verifyRecord,
} from "./chain.ts";
import { loadSigningKey, type SigningKey } from "./crypto.ts";
import {
	type DeviceEncryptionKey,
	generateDeviceEncryptionKey,
	loadDeviceEncryptionKey,
} from "./device-encryption.ts";
import { type EpochEnvelope, openEpochKey } from "./epoch-envelope.ts";
import { generatePrivateKey, type PrivateKeyDocument } from "./identity.ts";
import { decode, encode } from "./msgpack.ts";
import { createLibraryRecovery, parseRecoveryGenesis } from "./recovery-key.ts";
import { checkServer } from "./server.ts";

// Leave room for the authenticated pairing packet around local credential fields.
export const MAX_CREDENTIAL_BYTES = 1024 * 1024 - 1024;
export type DevicePhase = "registering" | "pairing" | "active" | "recovering";
export interface PendingRotation {
	readonly secret: Bytes;
	readonly record: Bytes;
}
export interface DeviceIdentity {
	readonly serverUrl: string;
	readonly genesis: Bytes;
	readonly library: Bytes;
	readonly privateKey: PrivateKeyDocument;
	readonly encryption: DeviceEncryptionKey;
	readonly epochs: readonly (readonly [number, Bytes])[];
	readonly head: Checkpoint;
	readonly phase: DevicePhase;
	readonly rotation: PendingRotation | null;
	readonly registration: Bytes | null;
	readonly recovery: Bytes | null;
}
export interface LoadedDevice {
	readonly identity: DeviceIdentity;
	readonly key: SigningKey;
	readonly encryptionKey: CryptoKeyPair;
}
function frame(value: unknown, length: number): unknown[] {
	if (!Array.isArray(value) || value.length !== length) {
		throw new Error("Invalid device credentials.");
	}
	return value;
}
function keyValues(value: PrivateKeyDocument) {
	return [value.seed, value.public_key];
}
function keyDocument(value: unknown): PrivateKeyDocument {
	const values = frame(value, 2);
	return {
		v: 1,
		seed: fixedBytes(values[0]),
		public_key: fixedBytes(values[1]),
	};
}
export function encodeDevice(identity: DeviceIdentity): Bytes {
	const pending = identity.rotation;
	const bytes = encode([
		1,
		identity.serverUrl,
		identity.genesis,
		identity.library,
		[
			...keyValues(identity.privateKey),
			identity.encryption.secret,
			identity.encryption.publicKey,
		],
		identity.epochs,
		[identity.head.sequence, fixedBytesHex(identity.head.hash)],
		identity.phase,
		pending ? [pending.secret, pending.record] : null,
		identity.registration,
		identity.recovery,
	]);
	if (bytes.length > MAX_CREDENTIAL_BYTES) {
		throw new Error("Device credentials exceed the supported size.");
	}
	return bytes;
}
function fixedBytesHex(hash: string) {
	if (!/^[0-9a-f]{64}$/.test(hash)) {
		throw new Error("Invalid trusted head.");
	}
	return Uint8Array.from(hash.match(/../g) ?? [], (part) =>
		Number.parseInt(part, 16),
	);
}
export async function decodeDevice(input: Bytes): Promise<LoadedDevice> {
	if (input.length > MAX_CREDENTIAL_BYTES) {
		throw new Error("Device credentials exceed the supported size.");
	}
	const values = frame(decode(input), 11);
	if (values[0] !== 1 || typeof values[1] !== "string") {
		throw new Error("Invalid device credentials.");
	}
	checkServer(values[1]);
	const serverUrl = new URL(values[1]).origin;
	if (serverUrl !== values[1]) {
		throw new Error("Device server must be a normalized origin.");
	}
	const genesisBytes = fixedBytesVariable(values[2]);
	const initial = await parseRecoveryGenesis(genesisBytes);
	const library = fixedBytes(values[3]);
	if (
		!sameBytes(genesisBytes, initial.bytes) ||
		!sameBytes(library, initial.hash)
	) {
		throw new Error("Device genesis and library identity do not match.");
	}
	const localKeys = frame(values[4], 4);
	const privateKey = keyDocument(localKeys.slice(0, 2));
	const encryption = {
		secret: fixedBytes(localKeys[2]),
		publicKey: fixedBytes(localKeys[3]),
	};
	const encryptionKey = await loadDeviceEncryptionKey(encryption);
	const key = await loadSigningKey(privateKey);
	if (sameBytes(key.publicKey, initial.recoveryPublicKey)) {
		throw new Error("Recovery key cannot be a device.");
	}
	if (!Array.isArray(values[5]) || !values[5].length) {
		throw new Error("Missing epoch secrets.");
	}
	const epochs = values[5].map((item: unknown, index: number) => {
		const pair = frame(item, 2);
		const epoch = safeInteger(pair[0], 1);
		if (epoch !== index + 1) {
			throw new Error("Epoch secrets must be complete and ordered.");
		}
		return [epoch, fixedBytes(pair[1])] as const;
	});
	const headValues = frame(values[6], 2);
	const head = {
		sequence: safeInteger(headValues[0]),
		hash: bytesToHex(fixedBytes(headValues[1])),
	};
	if (head.sequence === 0 && head.hash !== bytesToHex(library)) {
		throw new Error("Invalid genesis trusted head.");
	}
	const phase = values[7];
	if (
		phase !== "registering" &&
		phase !== "pairing" &&
		phase !== "active" &&
		phase !== "recovering"
	) {
		throw new Error("Invalid device preparation phase.");
	}
	const registration =
		values[9] === null ? null : fixedBytesVariable(values[9]);
	if (registration) {
		if (phase !== "registering") {
			throw new Error("Unexpected pending registration.");
		}
		const record = await verifyRecord(registration);
		const body = record.body;
		if (
			body.kind !== "enroll" ||
			body.sequence !== 1 ||
			body.epoch !== 1 ||
			!sameBytes(body.library, library) ||
			!sameBytes(body.previous, library) ||
			!sameBytes(body.signer, initial.recoveryPublicKey) ||
			!sameBytes(body.effects[0] as Bytes, key.publicKey) ||
			!sameBytes(body.effects[1] as Bytes, encryption.publicKey) ||
			(phase === "registering" &&
				(head.sequence !== 1 ||
					head.hash !== bytesToHex(record.hash) ||
					epochs.length < 1))
		) {
			throw new Error("Invalid pending registration.");
		}
	} else if (phase === "registering") {
		throw new Error("Missing signed first enrollment.");
	}
	let rotation: PendingRotation | null = null;
	if (values[8] !== null) {
		if (phase !== "active") {
			throw new Error("Invalid pending rotation phase.");
		}
		const pending = frame(values[8], 2);
		const secret = fixedBytes(pending[0]);
		const record = fixedBytesVariable(pending[1]);
		const verified = await verifyRecord(record);
		const body = verified.body;
		if (
			body.kind !== "rotate" ||
			body.epoch < epochs.length ||
			body.sequence !== head.sequence + 1 ||
			bytesToHex(body.previous) !== head.hash ||
			!sameBytes(body.library, library) ||
			!sameBytes(body.signer, initial.recoveryPublicKey) ||
			body.effects[0] !== body.epoch + 1
		) {
			throw new Error(
				"Pending rotation does not match the device credentials.",
			);
		}
		const envelope = (body.effects[2] as readonly EpochEnvelope[]).find(
			(entry) => sameBytes(entry[0], key.publicKey),
		);
		if (!envelope) {
			throw new Error("Pending rotation omits this device.");
		}
		const opened = await openEpochKey(
			{
				library,
				sequence: body.sequence,
				previous: body.previous,
				epoch: body.epoch,
				nextEpoch: body.epoch + 1,
				salt: body.effects[1] as Bytes,
				recipient: key.publicKey,
				encryptionPublicKey: encryption.publicKey,
			},
			encryptionKey,
			envelope,
		);
		try {
			if (!sameBytes(opened, secret)) {
				throw new Error("Pending rotation secret does not match its envelope.");
			}
		} finally {
			opened.fill(0);
		}
		rotation = { secret, record };
	}
	const recovery = values[10] === null ? null : fixedBytesVariable(values[10]);
	if (phase === "recovering") {
		if (!recovery || registration || rotation) {
			throw new Error("Recovery candidate requires its signed enrollment.");
		}
		const body = (await verifyRecord(recovery)).body;
		if (
			body.kind !== "enroll" ||
			body.epoch > epochs.length ||
			body.sequence !== head.sequence + 1 ||
			bytesToHex(body.previous) !== head.hash ||
			!sameBytes(body.library, library) ||
			!sameBytes(body.signer, initial.recoveryPublicKey) ||
			!sameBytes(body.effects[0] as Bytes, key.publicKey) ||
			!sameBytes(body.effects[1] as Bytes, encryption.publicKey)
		) {
			throw new Error(
				"Recovery enrollment does not match the local candidate.",
			);
		}
	} else if (recovery) {
		throw new Error("Unexpected pending recovery enrollment.");
	}
	const identity: DeviceIdentity = {
		serverUrl,
		genesis: genesisBytes,
		library,
		privateKey,
		encryption,
		epochs,
		head,
		phase,
		rotation,
		registration,
		recovery,
	};
	if (!sameBytes(input, encodeDevice(identity))) {
		throw new Error("Noncanonical device credentials.");
	}
	return { identity, key, encryptionKey };
}
function fixedBytesVariable(value: unknown): Bytes {
	if (!(value instanceof Uint8Array)) {
		throw new Error("Invalid binary credential field.");
	}
	return value.slice();
}
export async function createLibraryDevice(server: string) {
	checkServer(server);
	const { privateKey } = await generatePrivateKey();
	const encryption = await generateDeviceEncryptionKey();
	const created = await createLibraryRecovery(
		server,
		privateKey.public_key,
		encryption.publicKey,
	);
	const initial = created.recovery.genesis;
	const encoded = encodeDevice({
		serverUrl: new URL(server).origin,
		genesis: initial.bytes,
		library: initial.hash,
		privateKey,
		encryption,
		epochs: [[1, created.epochKey]],
		head: { sequence: 1, hash: bytesToHex(created.enrollment.hash) },
		phase: "registering",
		rotation: null,
		registration: created.enrollment.bytes,
		recovery: null,
	});
	try {
		return { device: await decodeDevice(encoded), recovery: created.recovery };
	} catch (error) {
		created.recovery.identity.signingKey.seed.fill(0);
		created.recovery.identity.epochDerivationSecret.fill(0);
		throw error;
	} finally {
		encoded.fill(0);
		privateKey.seed.fill(0);
		encryption.secret.fill(0);
		created.epochKey.fill(0);
	}
}

/** Preserve the candidate identity while pinning its exact recovery enrollment. */
export async function recoveryEnrollmentResult(
	current: LoadedDevice,
): Promise<LoadedDevice> {
	const pending = current.identity.recovery;
	if (!pending) {
		throw new Error("No pending recovery enrollment.");
	}
	const record = await verifyRecord(pending);
	return decodeDevice(
		encodeDevice({
			...current.identity,
			head: { sequence: record.body.sequence, hash: bytesToHex(record.hash) },
			phase: "active",
			recovery: null,
		}),
	);
}
