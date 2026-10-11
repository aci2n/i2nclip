import { b64urlToBytes, bytesToB64url, utf8 } from "./bytes.js";
import { checkServer } from "./server.js";

export const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_TTL_MS = 120_000;

export function pairingSecret() {
	return [...crypto.getRandomValues(new Uint8Array(8))]
		.map((byte) => PAIRING_ALPHABET[byte & 31])
		.join("");
}

export function parsePairingCode(value) {
	const code = value.toUpperCase().replace(/[\s-]/g, "");
	if (
		code.length !== 12 ||
		[...code].some((char) => !PAIRING_ALPHABET.includes(char))
	)
		throw new Error("Enter the 12-character pairing code.");
	return { id: code.slice(0, 4), secret: code.slice(4) };
}

export function formatPairingCode(id, secret) {
	return `${id}-${secret.slice(0, 4)}-${secret.slice(4)}`;
}

export function formatVerificationCode(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length !== 5)
		throw new Error("Invalid verification code.");
	let buffer = 0,
		bits = 0,
		code = "";
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			code += PAIRING_ALPHABET[(buffer >>> bits) & 31];
		}
		buffer &= (1 << bits) - 1;
	}
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function pairingOrigin(serverUrl) {
	checkServer(serverUrl);
	const url = new URL(serverUrl);
	if (
		url.protocol !== "https:" &&
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
	)
		throw new Error("Device pairing requires an HTTPS server.");
	return url.origin;
}

export function pairingContext(origin, room) {
	if (
		room?.v !== 1 ||
		!/^[A-Za-z0-9_-]{22}$/.test(room.instance) ||
		room.id?.length !== 4 ||
		[...room.id].some((char) => !PAIRING_ALPHABET.includes(char))
	)
		throw new Error("Invalid pairing response.");
	return `i2nclip/pairing/v1 ${origin} ${room.id} ${room.instance}`;
}

// The PAKE session key, not the short pairing secret, encrypts the transfer.
export async function pairingKeys(sessionKey, context) {
	const raw = b64urlToBytes(sessionKey);
	if (raw.length < 32) throw new Error("Invalid pairing key.");
	const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
		"deriveKey",
		"deriveBits",
	]);
	raw.fill(0);
	const derive = (direction) =>
		crypto.subtle.deriveKey(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: utf8(context),
				info: utf8(direction),
			},
			base,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		);
	const verification = new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: utf8(context),
				info: utf8("verification-code"),
			},
			base,
			40,
		),
	);
	try {
		return {
			transfer: await derive("transfer"),
			acknowledgment: await derive("acknowledgment"),
			verificationCode: formatVerificationCode(verification),
		};
	} finally {
		verification.fill(0);
	}
}

function aad(context, direction) {
	return utf8(`${context} ${direction} ${direction === "transfer" ? 4 : 5}`);
}

export async function sealPairing(keys, context, direction, value) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plain = utf8(JSON.stringify(value));
	if (plain.length > 4096) throw new Error("Invalid pairing payload.");
	try {
		const ciphertext = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: aad(context, direction) },
			keys[direction],
			plain,
		);
		return JSON.stringify({
			v: 1,
			iv: bytesToB64url(iv),
			ct: bytesToB64url(new Uint8Array(ciphertext)),
		});
	} finally {
		plain.fill(0);
	}
}

export async function openPairing(keys, context, direction, packet) {
	if (typeof packet !== "string" || packet.length > 8192)
		throw new Error("Invalid pairing payload.");
	const value = JSON.parse(packet);
	if (
		value.v !== 1 ||
		typeof value.iv !== "string" ||
		typeof value.ct !== "string"
	)
		throw new Error("Invalid pairing payload.");
	const iv = b64urlToBytes(value.iv),
		ct = b64urlToBytes(value.ct);
	if (iv.length !== 12 || ct.length > 4112 || ct.length < 16)
		throw new Error("Invalid pairing payload.");
	const plain = new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: aad(context, direction) },
			keys[direction],
			ct,
		),
	);
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
	} finally {
		plain.fill(0);
	}
}
