import type { Checkpoint } from "../chain-storage.ts";
import { bytesToHex } from "./bytes.ts";
import {
	type Bytes,
	fixedBytes,
	genesis,
	safeInteger,
	sameBytes,
	verifyRecord,
} from "./chain.ts";
import { loadSigningKey, type SigningKey } from "./crypto.ts";
import { generatePrivateKey, type PrivateKeyDocument } from "./identity.ts";
import { decode, encode } from "./msgpack.ts";
import { passwordOpen, passwordSeal } from "./password.ts";
import { checkServer } from "./server.ts";

export const MAX_DEVICE_BACKUP_BYTES = 1024 * 1024;
export const MAX_CREDENTIAL_BYTES = MAX_DEVICE_BACKUP_BYTES - 1024;
export type DevicePhase = "registering" | "pairing" | "active";
export interface PendingRotation {
	readonly replacement: PrivateKeyDocument;
	readonly secret: Bytes;
	readonly record: Bytes;
}
export interface DeviceIdentity {
	readonly serverUrl: string;
	readonly genesis: Bytes;
	readonly library: Bytes;
	readonly privateKey: PrivateKeyDocument;
	readonly epochs: readonly (readonly [number, Bytes])[];
	readonly head: Checkpoint;
	readonly phase: DevicePhase;
	readonly rotation: PendingRotation | null;
}
export interface LoadedDevice {
	readonly identity: DeviceIdentity;
	readonly key: SigningKey;
	readonly initialPublicKey: Bytes;
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
		keyValues(identity.privateKey),
		identity.epochs,
		[identity.head.sequence, fixedBytesHex(identity.head.hash)],
		identity.phase,
		pending
			? [keyValues(pending.replacement), pending.secret, pending.record]
			: null,
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
	const values = frame(decode(input), 9);
	if (values[0] !== 1 || typeof values[1] !== "string") {
		throw new Error("Invalid device credentials.");
	}
	checkServer(values[1]);
	const serverUrl = new URL(values[1]).origin;
	if (serverUrl !== values[1]) {
		throw new Error("Device server must be a normalized origin.");
	}
	const genesisBytes = fixedBytesVariable(values[2]);
	const genesisValues = frame(decode(genesisBytes), 3);
	const initialPublicKey = fixedBytes(genesisValues[1]);
	const initial = await genesis(initialPublicKey);
	const library = fixedBytes(values[3]);
	if (
		!sameBytes(genesisBytes, initial.bytes) ||
		!sameBytes(library, initial.hash)
	) {
		throw new Error("Device genesis and library identity do not match.");
	}
	const privateKey = keyDocument(values[4]);
	const key = await loadSigningKey(privateKey);
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
	if (phase !== "registering" && phase !== "pairing" && phase !== "active") {
		throw new Error("Invalid device preparation phase.");
	}
	if (
		phase === "registering" &&
		(head.sequence !== 0 ||
			epochs.length !== 1 ||
			!sameBytes(key.publicKey, initialPublicKey))
	) {
		throw new Error("Invalid pending registration.");
	}
	let rotation: PendingRotation | null = null;
	if (values[8] !== null) {
		if (phase !== "active") {
			throw new Error("Only active devices can prepare rotation.");
		}
		const pending = frame(values[8], 3);
		const replacement = keyDocument(pending[0]);
		await loadSigningKey(replacement);
		const secret = fixedBytes(pending[1]);
		const record = fixedBytesVariable(pending[2]);
		const verified = await verifyRecord(record);
		const body = verified.body;
		if (
			body.kind !== "rotate" ||
			body.epoch !== epochs.length ||
			body.sequence !== head.sequence + 1 ||
			bytesToHex(body.previous) !== head.hash ||
			!sameBytes(body.library, library) ||
			!sameBytes(body.signer, key.publicKey) ||
			body.effects[0] !== epochs.length + 1 ||
			!(body.effects[1] instanceof Uint8Array) ||
			!sameBytes(body.effects[1], replacement.public_key) ||
			sameBytes(key.publicKey, replacement.public_key)
		) {
			throw new Error(
				"Pending rotation does not match the device credentials.",
			);
		}
		rotation = { replacement, secret, record };
	}
	const identity: DeviceIdentity = {
		serverUrl,
		genesis: genesisBytes,
		library,
		privateKey,
		epochs,
		head,
		phase,
		rotation,
	};
	if (!sameBytes(input, encodeDevice(identity))) {
		throw new Error("Noncanonical device credentials.");
	}
	return { identity, key, initialPublicKey };
}
function fixedBytesVariable(value: unknown): Bytes {
	if (!(value instanceof Uint8Array)) {
		throw new Error("Invalid binary credential field.");
	}
	return value.slice();
}
export async function createDevice(server: string): Promise<LoadedDevice> {
	checkServer(server);
	const { privateKey } = await generatePrivateKey();
	const initial = await genesis(privateKey.public_key);
	return decodeDevice(
		encodeDevice({
			serverUrl: new URL(server).origin,
			genesis: initial.bytes,
			library: initial.hash,
			privateKey,
			epochs: [[1, crypto.getRandomValues(new Uint8Array(32))]],
			head: { sequence: 0, hash: bytesToHex(initial.hash) },
			phase: "registering",
			rotation: null,
		}),
	);
}
export async function exportDeviceBackup(
	identity: DeviceIdentity,
	password: string,
): Promise<Bytes> {
	if (password.length < 8) {
		throw new Error("Backup password must be at least 8 characters.");
	}
	const plaintext = encodeDevice(identity);
	try {
		await decodeDevice(plaintext);
		const bytes = encode([
			"i2nclip-device-backup",
			1,
			await passwordSeal(plaintext, password, "i2nclip/device-backup/1"),
		]);
		if (bytes.length > MAX_DEVICE_BACKUP_BYTES) {
			throw new Error("Device backup exceeds the supported size.");
		}
		return bytes;
	} finally {
		plaintext.fill(0);
	}
}
export async function openDeviceBackup(
	bytes: Bytes,
	password: string,
): Promise<LoadedDevice> {
	if (bytes.length > MAX_DEVICE_BACKUP_BYTES) {
		throw new Error("Device backup exceeds the supported size.");
	}
	const values = frame(decode(bytes), 3);
	if (values[0] !== "i2nclip-device-backup" || values[1] !== 1) {
		throw new Error("Invalid device backup.");
	}
	if (!sameBytes(bytes, encode(values))) {
		throw new Error("Noncanonical device backup.");
	}
	const plaintext = await passwordOpen(
		values[2],
		password,
		"i2nclip/device-backup/1",
	);
	try {
		return await decodeDevice(plaintext);
	} finally {
		plaintext.fill(0);
	}
}
