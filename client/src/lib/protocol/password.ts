import { utf8 } from "./bytes.ts";
import { PAIRING_ALPHABET } from "./pairing.ts";
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
const BACKUP_GROUPS = 8;

/** A random backup password: 32 pairing-alphabet characters (160 bits) in groups of four. */
export function backupPassword() {
	const random = crypto.getRandomValues(new Uint8Array(BACKUP_GROUPS * 4));
	const text = [...random].map((byte) => PAIRING_ALPHABET[byte & 31]).join("");
	random.fill(0);
	return text.match(/.{4}/g)?.join("-") ?? "";
}

/** HKDF suffices because the password is already a uniformly random secret. */
export async function backupKey(password: string, purpose: string) {
	const normalized = password.toUpperCase().replace(/[\s-]/g, "");
	if (
		normalized.length !== BACKUP_GROUPS * 4 ||
		[...normalized].some((char) => !PAIRING_ALPHABET.includes(char))
	) {
		throw new Error("Enter the 32-character backup password.");
	}
	const base = await crypto.subtle.importKey(
		"raw",
		utf8(normalized),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(),
			info: utf8(purpose),
		},
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}
