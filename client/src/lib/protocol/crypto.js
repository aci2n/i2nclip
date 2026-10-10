// Encryption and request signatures. Must match src/crypto.rs byte for byte.
// The lock is client/tests/test-vectors.json, produced by the Rust tests.
//
// The secret is the 32-byte seed in a library identity. From it:
//
// - Ed25519 signs HTTP requests. The server only has the public key.
// - HKDF-SHA256 with salt "i2nclip" and info "enc" is the AES-256-GCM key.
// - The same HKDF with info "tag" is the HMAC key for tag fingerprints.
//
// Those are two keys on purpose. A bug in tag search must not decrypt a file.

import {
	bytesToB64url,
	bytesToHex,
	concat,
	hexToBytes,
	utf8,
} from "./bytes.js";
import { parsePrivateKey } from "./identity.js";

const PKCS8_PREFIX = hexToBytes("302e020100300506032b657004220420");

export function contentAad(id) {
	return utf8(`i2nclip/v1 content ${id}`);
}

export function metaAad(id) {
	return utf8(`i2nclip/v1 meta ${id}`);
}

/** Trim, NFC, lowercase. Same rules as `normalize_tag` in Rust. */
export function normalizeTag(tag) {
	const text = tag.trim().normalize("NFC").toLowerCase();
	if (!text || [...text].length > 64 || /[\n\r,]/.test(text)) {
		throw new Error("bad tag");
	}
	return text;
}

/** Split user-entered tags while preserving spelling in encrypted metadata. */
export function splitTags(text) {
	if (Array.isArray(text)) return text.flatMap(splitTags);
	return String(text ?? "")
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

export function parseTagList(text) {
	return splitTags(text).map(normalizeTag);
}

/**
 * Load an internal library identity document.
 * Returns the public key to register on the server, plus handles the
 * page can pass back into encrypt/sign without parsing again.
 */
export async function loadKey(privateKey) {
	const parsed = parsePrivateKey(privateKey);
	const { privateCryptoKey } = await materialFromSeed(
		parsed.seed,
		parsed.publicKey,
	);
	return {
		privateCryptoKey,
		publicKey: parsed.publicKey,
		registrationKey: bytesToB64url(parsed.publicKey),
		seed: parsed.seed,
	};
}

export async function tagToken(key, tag) {
	const seed = await seedOf(key);
	const raw = await hmac(
		await hkdf(seed, "tag"),
		utf8(`tag\n${normalizeTag(tag)}`),
	);
	return bytesToB64url(raw);
}

export async function tagTokens(key, tags) {
	const out = [];
	for (const tag of parseTagList(tags)) {
		const token = await tagToken(key, tag);
		if (!out.includes(token)) out.push(token);
	}
	return out;
}

/** version byte || 12-byte nonce || AES-GCM ciphertext (tag appended). */
export async function encrypt(key, aad, plaintext, nonce) {
	const seed = await seedOf(key);
	const iv = nonce ?? crypto.getRandomValues(new Uint8Array(12));
	const aes = await crypto.subtle.importKey(
		"raw",
		await hkdf(seed, "enc"),
		"AES-GCM",
		false,
		["encrypt"],
	);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: aad },
			aes,
			plaintext,
		),
	);
	const out = new Uint8Array(1 + iv.length + ct.length);
	out[0] = 1;
	out.set(iv, 1);
	out.set(ct, 1 + iv.length);
	return out;
}

export async function decrypt(key, aad, blob) {
	if (blob.length < 1 + 12 + 16 || blob[0] !== 1) {
		throw new Error("crypto");
	}
	const seed = await seedOf(key);
	const iv = blob.subarray(1, 13);
	const ct = blob.subarray(13);
	const aes = await crypto.subtle.importKey(
		"raw",
		await hkdf(seed, "enc"),
		"AES-GCM",
		false,
		["decrypt"],
	);
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: aad },
			aes,
			ct,
		),
	);
}

// One signature. The body hash is a field of the Authorization header and the
// last line of the signed message, so the server can check the signature
// before it reads the body.
export async function bodyHash(body) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
	return bytesToHex(digest);
}

export function requestMessage({ origin, ts, nonce, method, path, hash }) {
	return utf8(
		`i2nclip-auth-v1\n${origin}\n${ts}\n${nonce}\n${method}\n${path}\n${hash}\n`,
	);
}

export async function authorizationHeader({
	key,
	origin,
	ts,
	nonce,
	method,
	path,
	body,
}) {
	const loaded = key.privateCryptoKey
		? key
		: await loadKey(key.privateKey ?? key);
	const hash = await bodyHash(body);
	const request = requestMessage({ origin, ts, nonce, method, path, hash });
	const { privateCryptoKey, publicKey } = loaded;
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: "Ed25519" }, privateCryptoKey, request),
	);
	return `Bearer ${bytesToB64url(publicKey)}.${ts}.${nonce}.${hash}.${bytesToB64url(signature)}`;
}

export function freshNonce() {
	return bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
}

async function seedOf(key) {
	if (key instanceof Uint8Array) return key;
	if (key.seed) return key.seed;
	return (await loadKey(key.privateKey ?? key)).seed;
}

async function materialFromSeed(seed, publicKey) {
	// WebCrypto will not import a raw Ed25519 seed. It will import PKCS#8, and
	// an Ed25519 PKCS#8 key is a fixed 16-byte header plus that seed.
	// Firefox can sign with that key, then refuses to export it as a JWK, so
	// the public key comes from the identity document and is checked with a signature.
	const pkcs8 = concat([PKCS8_PREFIX, seed]);
	const privateCryptoKey = await crypto.subtle.importKey(
		"pkcs8",
		pkcs8,
		{ name: "Ed25519" },
		false,
		["sign"],
	);
	const probe = utf8("i2nclip");
	const signature = await crypto.subtle.sign(
		{ name: "Ed25519" },
		privateCryptoKey,
		probe,
	);
	const verifying = await crypto.subtle.importKey(
		"raw",
		publicKey,
		{ name: "Ed25519" },
		false,
		["verify"],
	);
	const matches = await crypto.subtle.verify(
		{ name: "Ed25519" },
		verifying,
		signature,
		probe,
	);
	if (!matches)
		throw new Error("Library identity does not match its public key");
	return { privateCryptoKey, publicKey };
}

async function hkdf(seed, info) {
	const base = await crypto.subtle.importKey("raw", seed, "HKDF", false, [
		"deriveBits",
	]);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: utf8("i2nclip"),
				info: utf8(info),
			},
			base,
			256,
		),
	);
}

async function hmac(keyBytes, data) {
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
