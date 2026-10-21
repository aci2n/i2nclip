import {
	AEAD_AES_256_GCM,
	CipherSuite,
	KDF_HKDF_SHA256,
	KEM_DHKEM_X25519_HKDF_SHA256,
} from "hpke";
import { bytesToHex } from "./bytes.ts";
import {
	type Bytes,
	compareBytes,
	fixedBytes,
	MAX_AUTHORIZED_DEVICES,
	safeInteger,
	sameBytes,
} from "./chain.ts";
import { encode } from "./msgpack.ts";

// HPKE base mode; the recovery signature authenticates the complete rotation.
const suite = new CipherSuite(
	KEM_DHKEM_X25519_HKDF_SHA256,
	KDF_HKDF_SHA256,
	AEAD_AES_256_GCM,
);

export interface DeviceEncryptionKey {
	readonly secret: Bytes;
	readonly publicKey: Bytes;
}
export interface EpochEnvelopeContext {
	readonly library: Bytes;
	readonly sequence: number;
	readonly previous: Bytes;
	readonly epoch: number;
	readonly nextEpoch: number;
	readonly salt: Bytes;
	readonly recipient: Bytes;
	readonly encryptionPublicKey: Bytes;
}
export type EpochEnvelope = readonly [Bytes, Bytes, Bytes];
export interface EpochRecipient {
	readonly publicKey: Bytes;
	readonly encryptionPublicKey: Bytes;
	readonly revokedAt: number | null;
}
export type EpochTransition = Omit<
	EpochEnvelopeContext,
	"recipient" | "encryptionPublicKey"
>;

function authorizedRecipients(devices: readonly EpochRecipient[]) {
	const active = devices
		.filter((device) => device.revokedAt === null)
		.sort((left, right) => compareBytes(left.publicKey, right.publicKey));
	if (active.length > MAX_AUTHORIZED_DEVICES) {
		throw new Error("Invalid authorized device count.");
	}
	const encryptionKeys = new Set<string>();
	for (let index = 0; index < active.length; index++) {
		const device = active[index];
		fixedBytes(device.publicKey);
		fixedBytes(device.encryptionPublicKey);
		const encryptionId = bytesToHex(device.encryptionPublicKey);
		if (
			(index > 0 && sameBytes(active[index - 1].publicKey, device.publicKey)) ||
			encryptionKeys.has(encryptionId)
		) {
			throw new Error("Duplicate device key binding.");
		}
		encryptionKeys.add(encryptionId);
	}
	return active;
}

/** Public validation does not establish correctness of other devices' ciphertexts. */
export function validateEpochEnvelopes(
	input: unknown,
	devices: readonly EpochRecipient[],
): readonly EpochEnvelope[] {
	const recipients = authorizedRecipients(devices);
	if (!Array.isArray(input) || input.length !== recipients.length) {
		throw new Error("Epoch envelopes must cover every authorized device.");
	}
	return input.map((entry: unknown, index: number) => {
		if (
			!Array.isArray(entry) ||
			entry.length !== 3 ||
			!sameBytes(fixedBytes(entry[0]), recipients[index].publicKey)
		) {
			throw new Error("Epoch envelopes must match sorted authorized devices.");
		}
		return [
			fixedBytes(entry[0]),
			fixedBytes(entry[1]),
			fixedBytes(entry[2], 48),
		] as const;
	});
}

/** Seal independently to the complete membership at the rotation's exact parent. */
export async function sealEpochKeys(
	transition: EpochTransition,
	devices: readonly EpochRecipient[],
	epochKey: Bytes,
): Promise<readonly EpochEnvelope[]> {
	const result: EpochEnvelope[] = [];
	for (const device of authorizedRecipients(devices)) {
		result.push(
			await sealEpochKey(
				{
					...transition,
					recipient: device.publicKey,
					encryptionPublicKey: device.encryptionPublicKey,
				},
				epochKey,
			),
		);
	}
	return result;
}

function options(context: EpochEnvelopeContext) {
	const epoch = safeInteger(context.epoch, 1);
	if (safeInteger(context.nextEpoch, 2) !== epoch + 1) {
		throw new Error("Epoch must advance by one.");
	}
	return {
		info: encode(["i2nclip/epoch-envelope/1", fixedBytes(context.library)]),
		aad: encode([
			"i2nclip/epoch-envelope-context/1",
			fixedBytes(context.library),
			safeInteger(context.sequence, 1),
			fixedBytes(context.previous),
			epoch,
			context.nextEpoch,
			fixedBytes(context.salt),
			fixedBytes(context.recipient),
			fixedBytes(context.encryptionPublicKey),
		]),
	};
}

export async function generateDeviceEncryptionKey(): Promise<DeviceEncryptionKey> {
	const pair = await suite.GenerateKeyPair(true);
	return {
		secret: fixedBytes(await suite.SerializePrivateKey(pair.privateKey)),
		publicKey: fixedBytes(await suite.SerializePublicKey(pair.publicKey)),
	};
}

/** Imports a local-only credential and checks its public/private correspondence. */
export async function loadDeviceEncryptionKey(document: DeviceEncryptionKey) {
	const secret = fixedBytes(document.secret);
	try {
		const privateKey = await suite.DeserializePrivateKey(secret);
		const publicKey = await suite.DeserializePublicKey(
			fixedBytes(document.publicKey),
		);
		const probe = crypto.getRandomValues(new Uint8Array(32));
		let opened: Uint8Array | undefined;
		try {
			const sealed = await suite.Seal(publicKey, probe);
			opened = await suite.Open(
				{ privateKey, publicKey },
				sealed.encapsulatedSecret,
				sealed.ciphertext,
			);
			if (
				opened.length !== probe.length ||
				opened.some((value, i) => value !== probe[i])
			) {
				throw new Error("Device encryption keys do not match.");
			}
		} finally {
			probe.fill(0);
			opened?.fill(0);
		}
		return { privateKey, publicKey };
	} finally {
		secret.fill(0);
	}
}

export async function sealEpochKey(
	context: EpochEnvelopeContext,
	epochKey: Bytes,
): Promise<EpochEnvelope> {
	const configuration = options(context);
	const plaintext = fixedBytes(epochKey);
	try {
		const recipient = await suite.DeserializePublicKey(
			fixedBytes(context.encryptionPublicKey),
		);
		const result = await suite.Seal(recipient, plaintext, configuration);
		return [
			fixedBytes(context.recipient),
			fixedBytes(result.encapsulatedSecret),
			fixedBytes(result.ciphertext, 48),
		];
	} finally {
		plaintext.fill(0);
	}
}

export async function openEpochKey(
	context: EpochEnvelopeContext,
	privateKey: CryptoKeyPair,
	envelope: EpochEnvelope,
): Promise<Bytes> {
	const configuration = options(context);
	if (
		envelope[0].length !== 32 ||
		envelope[0].some((byte, i) => byte !== context.recipient[i])
	) {
		throw new Error("Wrong epoch envelope recipient.");
	}
	const plaintext = await suite.Open(
		privateKey,
		fixedBytes(envelope[1]),
		fixedBytes(envelope[2], 48),
		configuration,
	);
	try {
		return fixedBytes(plaintext);
	} finally {
		plaintext.fill(0);
	}
}
