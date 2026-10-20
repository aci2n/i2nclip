import { utf8 } from "./bytes.ts";
import { bytes } from "./value.ts";
export const PBKDF2_ITERATIONS = 600_000;
type EncryptedBytes = readonly [
	1,
	Uint8Array<ArrayBuffer>,
	Uint8Array<ArrayBuffer>,
];

export async function wrappingKey(
	passphrase: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number,
) {
	const base = await crypto.subtle.importKey(
		"raw",
		utf8(passphrase),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function sealBytes(
	key: CryptoKey,
	plaintext: Uint8Array<ArrayBuffer>,
	purpose: string,
): Promise<EncryptedBytes> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: utf8(purpose) },
		key,
		plaintext,
	);
	return [1, iv, new Uint8Array(ct)];
}
export async function openBytes(
	key: CryptoKey,
	input: unknown,
	purpose: string,
) {
	if (
		!Array.isArray(input) ||
		input.length !== 3 ||
		input[0] !== 1 ||
		!(input[1] instanceof Uint8Array) ||
		input[1].length !== 12 ||
		!(input[2] instanceof Uint8Array) ||
		input[2].length < 16
	) {
		throw new Error("Invalid encrypted data.");
	}
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bytes(input[1]), additionalData: utf8(purpose) },
			key,
			bytes(input[2]),
		),
	);
}
export async function passwordSeal(
	plaintext: Uint8Array<ArrayBuffer>,
	password: string,
	purpose: string,
) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
	const [, iv, ct] = await sealBytes(key, plaintext, purpose);
	return [1, salt, PBKDF2_ITERATIONS, iv, ct] as const;
}
export async function passwordOpen(
	input: unknown,
	password: string,
	purpose: string,
) {
	if (
		!Array.isArray(input) ||
		input.length !== 5 ||
		input[0] !== 1 ||
		!(input[1] instanceof Uint8Array) ||
		input[1].length !== 16 ||
		!Number.isInteger(input[2]) ||
		input[2] < PBKDF2_ITERATIONS ||
		input[2] > 2_000_000
	) {
		throw new Error("Invalid encrypted data.");
	}
	// Validate all cheap framing before the deliberately expensive password KDF.
	if (
		!(input[3] instanceof Uint8Array) ||
		input[3].length !== 12 ||
		!(input[4] instanceof Uint8Array) ||
		input[4].length < 16
	) {
		throw new Error("Invalid encrypted data.");
	}
	const key = await wrappingKey(password, bytes(input[1]), input[2]);
	try {
		return await openBytes(key, [1, input[3], input[4]], purpose);
	} catch {
		throw new Error("Wrong password or damaged encrypted data.");
	}
}
