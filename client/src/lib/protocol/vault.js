// Encrypt the library identity before it is written to the Firefox profile.
// The passphrase is not an input we store. PBKDF2 turns it into an AES key,
// AES-GCM encrypts the key text, and a wrong passphrase fails the auth tag.

import { b64ToBytes, bytesToB64, utf8 } from "./bytes.js";

// OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Unlock takes a fraction of a
// second on purpose, so guessing the passphrase is slow.
export const PBKDF2_ITERATIONS = 600_000;

export async function wrapPrivateKey(
	privateKey,
	passphrase,
	iterations = PBKDF2_ITERATIONS,
) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await wrappingKey(passphrase, salt, iterations);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(privateKey)),
	);
	return {
		v: 1,
		iterations,
		salt: bytesToB64(salt),
		iv: bytesToB64(iv),
		ct: bytesToB64(ct),
	};
}

export async function unwrapPrivateKey(wrapped, passphrase) {
	validateWrappedKey(wrapped);
	const key = await wrappingKey(
		passphrase,
		b64ToBytes(wrapped.salt),
		wrapped.iterations,
	);
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: b64ToBytes(wrapped.iv) },
			key,
			b64ToBytes(wrapped.ct),
		);
		return new TextDecoder().decode(plain);
	} catch {
		throw new Error("Wrong password or damaged recovery file.");
	}
}

async function wrappingKey(passphrase, salt, iterations) {
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

export function validateWrappedKey(wrapped) {
	if (
		wrapped?.v !== 1 ||
		!Number.isInteger(wrapped.iterations) ||
		wrapped.iterations < 1 ||
		wrapped.iterations > 2_000_000
	) {
		throw new Error("Invalid encrypted library.");
	}
	for (const [name, min, max] of [
		["salt", 16, 16],
		["iv", 12, 12],
		["ct", 17, 4096],
	]) {
		const text = wrapped[name];
		if (typeof text !== "string" || text.length > 5500)
			throw new Error("Invalid encrypted library.");
		let bytes;
		try {
			bytes = b64ToBytes(text);
		} catch {
			throw new Error("Invalid encrypted library.");
		}
		if (
			bytes.length < min ||
			bytes.length > max ||
			bytesToB64(bytes) !== text
		) {
			throw new Error("Invalid encrypted library.");
		}
	}
}
