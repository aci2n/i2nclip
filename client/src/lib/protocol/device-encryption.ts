import {
	AEAD_AES_256_GCM,
	CipherSuite,
	KDF_HKDF_SHA256,
	KEM_DHKEM_X25519_HKDF_SHA256,
} from "hpke";
import { type Bytes, fixedBytes } from "./chain.ts";

// Native RFC 9180 suite shared by epoch delivery and pairing key-possession proof.
const suite = new CipherSuite(
	KEM_DHKEM_X25519_HKDF_SHA256,
	KDF_HKDF_SHA256,
	AEAD_AES_256_GCM,
);

export interface DeviceEncryptionKey {
	readonly secret: Bytes;
	readonly publicKey: Bytes;
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

export async function sealToDevice(
	publicKey: Bytes,
	plaintext: Bytes,
	info: Bytes,
	aad: Bytes,
): Promise<readonly [Bytes, Bytes]> {
	const recipient = await suite.DeserializePublicKey(fixedBytes(publicKey));
	const sealed = await suite.Seal(recipient, plaintext, { info, aad });
	return [
		fixedBytes(sealed.encapsulatedSecret),
		new Uint8Array(sealed.ciphertext),
	];
}
export async function openToDevice(
	key: CryptoKeyPair,
	encapsulated: Bytes,
	ciphertext: Bytes,
	info: Bytes,
	aad: Bytes,
): Promise<Bytes> {
	return new Uint8Array(
		await suite.Open(key, fixedBytes(encapsulated), ciphertext, { info, aad }),
	);
}
