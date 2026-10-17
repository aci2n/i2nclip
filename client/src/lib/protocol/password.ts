import { utf8 } from "./bytes.ts";
import { bytes, document } from "./value.ts";
export const PBKDF2_ITERATIONS = 600_000;

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

// The same primitives protect the saved identity and portable recovery manifests.
export async function sealBytes(
	key: CryptoKey,
	bytes: Uint8Array<ArrayBuffer>,
	purpose: string,
) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: utf8(purpose) },
		key,
		bytes,
	);
	return {
		v: 1,
		iv,
		ct: new Uint8Array(ct),
	};
}
export async function openBytes(
	key: CryptoKey,
	input: unknown,
	purpose: string,
) {
	const record = document(input);
	if (
		record.v !== 1 ||
		!(record.iv instanceof Uint8Array) ||
		!(record.ct instanceof Uint8Array)
	) {
		throw new Error("Invalid encrypted data.");
	}
	const iv = bytes(record.iv);
	if (iv.length !== 12 || record.ct.length < 16) {
		throw new Error("Invalid encrypted data.");
	}
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: utf8(purpose) },
			key,
			bytes(record.ct),
		),
	);
}
export async function passwordSeal(
	bytes: Uint8Array<ArrayBuffer>,
	password: string,
	purpose: string,
) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iterations = PBKDF2_ITERATIONS;
	const key = await wrappingKey(password, salt, iterations);
	return {
		...(await sealBytes(key, bytes, purpose)),
		salt,
		iterations,
	};
}
export async function passwordOpen(
	input: unknown,
	password: string,
	purpose: string,
) {
	const record = document(input);
	if (
		typeof record.iterations !== "number" ||
		!Number.isInteger(record.iterations) ||
		record.iterations < PBKDF2_ITERATIONS ||
		record.iterations > 2_000_000 ||
		!(record.salt instanceof Uint8Array)
	) {
		throw new Error("Invalid encrypted data.");
	}
	const salt = bytes(record.salt);
	if (salt.length !== 16) {
		throw new Error("Invalid encrypted data.");
	}
	const key = await wrappingKey(password, salt, record.iterations);
	try {
		return await openBytes(key, record, purpose);
	} catch {
		throw new Error("Wrong password or damaged encrypted data.");
	}
}
