import { b64ToBytes, bytesToB64, utf8 } from "./bytes.js";

export const PBKDF2_ITERATIONS = 600_000;

export async function wrappingKey(passphrase, salt, iterations) {
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

// The same primitives protect the local vault and portable recovery manifests.
export async function sealBytes(key, bytes, purpose, { binary = false } = {}) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: utf8(purpose) },
		key,
		bytes,
	);
	return {
		v: 1,
		iv: binary ? iv : bytesToB64(iv),
		ct: binary ? new Uint8Array(ct) : bytesToB64(new Uint8Array(ct)),
	};
}
export async function openBytes(key, record, purpose) {
	if (
		record?.v !== 1 ||
		!(typeof record.iv === "string" || record.iv instanceof Uint8Array) ||
		!(typeof record.ct === "string" || record.ct instanceof Uint8Array)
	)
		throw new Error("Invalid encrypted data.");
	const iv = typeof record.iv === "string" ? b64ToBytes(record.iv) : record.iv;
	if (iv.length !== 12) throw new Error("Invalid encrypted data.");
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: utf8(purpose) },
			key,
			typeof record.ct === "string" ? b64ToBytes(record.ct) : record.ct,
		),
	);
}
export async function passwordSeal(bytes, password, purpose) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iterations = PBKDF2_ITERATIONS;
	const key = await wrappingKey(password, salt, iterations);
	return {
		...(await sealBytes(key, bytes, purpose)),
		salt: bytesToB64(salt),
		iterations,
	};
}
export async function passwordOpen(record, password, purpose) {
	if (
		!Number.isInteger(record?.iterations) ||
		record.iterations < PBKDF2_ITERATIONS ||
		record.iterations > 2_000_000 ||
		typeof record.salt !== "string"
	)
		throw new Error("Invalid encrypted data.");
	const salt = b64ToBytes(record.salt);
	if (salt.length !== 16) throw new Error("Invalid encrypted data.");
	const key = await wrappingKey(password, salt, record.iterations);
	try {
		return await openBytes(key, record, purpose);
	} catch {
		throw new Error("Wrong password or damaged encrypted data.");
	}
}
export async function importVaultKey(bytes) {
	if (bytes.length !== 32) throw new Error("Invalid vault key.");
	return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}
