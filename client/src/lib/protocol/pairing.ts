import { b64urlToBytes, utf8 } from "./bytes.ts";
import { sameBytes } from "./chain.ts";
import { decode, encode } from "./msgpack.ts";
import { checkServer } from "./server.ts";
import { document } from "./value.ts";
export interface PairingKeys {
	readonly transfer: CryptoKey;
	readonly acknowledgment: CryptoKey;
	readonly verificationCode: string;
}
export type Direction = "transfer" | "acknowledgment";
const PHASE: Record<Direction, number> = { transfer: 4, acknowledgment: 5 };
export const MAX_PAIRING_PACKET_BYTES = 1024 * 1024;
function plaintextLimit(direction: Direction) {
	return direction === "transfer" ? MAX_PAIRING_PACKET_BYTES - 64 : 4096;
}
function packetLimit(direction: Direction) {
	return direction === "transfer" ? MAX_PAIRING_PACKET_BYTES : 8192;
}

export const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_TTL_MS = 120_000;

export function pairingSecret() {
	return [...crypto.getRandomValues(new Uint8Array(8))]
		.map((byte) => PAIRING_ALPHABET[byte & 31])
		.join("");
}

export function parsePairingCode(value: string) {
	const code = value.toUpperCase().replace(/[\s-]/g, "");
	if (
		code.length !== 12 ||
		[...code].some((char) => !PAIRING_ALPHABET.includes(char))
	) {
		throw new Error("Enter the 12-character pairing code.");
	}
	return { id: code.slice(0, 4), secret: code.slice(4) };
}

export function formatPairingCode(id: string, secret: string) {
	return `${id}-${secret.slice(0, 4)}-${secret.slice(4)}`;
}

export function formatVerificationCode(bytes: unknown) {
	if (!(bytes instanceof Uint8Array) || bytes.length !== 5) {
		throw new Error("Invalid verification code.");
	}
	let buffer = 0;
	let bits = 0;
	let code = "";
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

export function pairingOrigin(serverUrl: string) {
	checkServer(serverUrl);
	const url = new URL(serverUrl);
	if (
		url.protocol !== "https:" &&
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
	) {
		throw new Error("Pairing requires an HTTPS server.");
	}
	return url.origin;
}

export function pairingContext(origin: string, input: unknown) {
	const room = document(input);
	if (
		room.v !== 1 ||
		typeof room.instance !== "string" ||
		!/^[A-Za-z0-9_-]{22}$/.test(room.instance) ||
		typeof room.id !== "string" ||
		room.id.length !== 4 ||
		[...room.id].some((char) => !PAIRING_ALPHABET.includes(char))
	) {
		throw new Error("Invalid pairing response.");
	}
	return `i2nclip/pairing/v1 ${origin} ${room.id} ${room.instance}`;
}

// The PAKE session key, not the short pairing secret, encrypts the transfer.
export async function pairingKeys(
	sessionKey: string,
	context: string,
): Promise<PairingKeys> {
	const raw = b64urlToBytes(sessionKey);
	if (raw.length < 32) {
		throw new Error("Invalid pairing key.");
	}
	let base: CryptoKey;
	try {
		base = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
			"deriveKey",
			"deriveBits",
		]);
	} finally {
		raw.fill(0);
	}

	const derive = (direction: string) =>
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

function aad(context: string, direction: Direction) {
	return utf8(`${context} ${direction} ${PHASE[direction]}`);
}

export async function sealPairing(
	keys: PairingKeys,
	context: string,
	direction: Direction,
	value: unknown,
) {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const plain = encode(value);
	try {
		if (plain.length > plaintextLimit(direction)) {
			throw new Error("Invalid pairing payload.");
		}
		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv: nonce, additionalData: aad(context, direction) },
				keys[direction],
				plain,
			),
		);
		return encode([1, nonce, ciphertext]);
	} finally {
		plain.fill(0);
	}
}
export async function openPairing(
	keys: PairingKeys,
	context: string,
	direction: Direction,
	packet: unknown,
) {
	if (
		!(packet instanceof Uint8Array) ||
		packet.length > packetLimit(direction)
	) {
		throw new Error("Invalid pairing payload.");
	}
	const value = decode(packet);
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		value[0] !== 1 ||
		!(value[1] instanceof Uint8Array) ||
		value[1].length !== 12 ||
		!(value[2] instanceof Uint8Array) ||
		value[2].length < 16 ||
		value[2].length > plaintextLimit(direction) + 16 ||
		!sameBytes(packet, encode(value))
	) {
		throw new Error("Invalid pairing payload.");
	}
	const plain = new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: new Uint8Array(value[1]),
				additionalData: aad(context, direction),
			},
			keys[direction],
			new Uint8Array(value[2]),
		),
	);
	try {
		const decoded = decode(plain);
		if (!sameBytes(plain, encode(decoded))) {
			throw new Error("Noncanonical pairing payload.");
		}
		return structuredClone(decoded);
	} finally {
		plain.fill(0);
	}
}
