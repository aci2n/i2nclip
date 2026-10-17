import {
	bytesToB64url,
	bytesToHex,
	concat,
	hexToBytes,
	utf8,
} from "./bytes.ts";
import { parsePrivateKey } from "./identity.ts";
import { decode, encode } from "./msgpack.ts";
import { normalizeTag, parseTagList } from "./tags.ts";
import { bytes, document } from "./value.ts";
export type LoadedKey = Awaited<ReturnType<typeof loadKey>>;
interface RequestMessage {
	origin: string;
	ts: number;
	nonce: string;
	method: string;
	path: string;
	hash: string;
}

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

const PKCS8_PREFIX = hexToBytes("302e020100300506032b657004220420");

export function contentAad() {
	return utf8("i2nclip/v1 content");
}

export function metaAad(id: string) {
	return utf8(`i2nclip/v1 meta ${id}`);
}

/**
 * Load an internal library identity document.
 * Returns the public key to register on the server, plus handles the
 * page can pass back into encrypt/sign without parsing again.
 */
export async function loadKey(privateKey: unknown) {
	const parsed = parsePrivateKey(privateKey);
	try {
		const { privateCryptoKey } = await materialFromSeed(
			parsed.seed,
			parsed.publicKey,
		);
		const encryptionKey = await crypto.subtle.importKey(
			"raw",
			await hkdf(parsed.seed, "enc"),
			"AES-GCM",
			false,
			["encrypt", "decrypt"],
		);
		const tagKey = await crypto.subtle.importKey(
			"raw",
			await hkdf(parsed.seed, "tag"),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		return Object.freeze({
			privateCryptoKey,
			encryptionKey,
			tagKey,
			publicKey: parsed.publicKey,
			registrationKey: bytesToB64url(parsed.publicKey),
		});
	} finally {
		parsed.seed.fill(0);
	}
}

export async function tagToken(key: LoadedKey, tag: string) {
	const raw = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key.tagKey,
			utf8(`tag\n${normalizeTag(tag)}`),
		),
	);
	return bytesToB64url(raw);
}

export async function tagTokens(key: LoadedKey, tags: unknown) {
	const out: string[] = [];
	for (const tag of parseTagList(tags)) {
		const token = await tagToken(key, tag);
		if (!out.includes(token)) {
			out.push(token);
		}
	}
	return out;
}

/** MessagePack envelope with version, nonce and authenticated ciphertext. */
export async function encrypt(
	key: LoadedKey,
	aad: Uint8Array<ArrayBuffer>,
	plaintext: Uint8Array<ArrayBuffer>,
	nonce?: Uint8Array<ArrayBuffer>,
) {
	const iv = nonce ?? crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: aad },
			key.encryptionKey,
			plaintext,
		),
	);
	return encode({ v: 1, iv, ct });
}

export async function decrypt(
	key: LoadedKey,
	aad: Uint8Array<ArrayBuffer>,
	blob: Uint8Array,
) {
	const { v, iv, ct } = document(decode(blob));
	if (
		v !== 1 ||
		!(iv instanceof Uint8Array) ||
		iv.length !== 12 ||
		!(ct instanceof Uint8Array) ||
		ct.length < 16
	) {
		throw new Error("crypto");
	}
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bytes(iv), additionalData: aad },
			key.encryptionKey,
			bytes(ct),
		),
	);
}

// One signature. The body hash is a field of the Authorization header and the
// last line of the signed message, so the server can check the signature
// before it reads the body.
export async function bodyHash(body: Uint8Array<ArrayBuffer>) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
	return bytesToHex(digest);
}

export function requestMessage({
	origin,
	ts,
	nonce,
	method,
	path,
	hash,
}: RequestMessage) {
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
}: Omit<RequestMessage, "hash"> & {
	key: LoadedKey;
	body?: Uint8Array<ArrayBuffer>;
}) {
	const hash = await bodyHash(body ?? new Uint8Array());
	const request = requestMessage({ origin, ts, nonce, method, path, hash });
	const { privateCryptoKey, publicKey } = key;
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: "Ed25519" }, privateCryptoKey, request),
	);
	return `Bearer ${bytesToB64url(publicKey)}.${ts}.${nonce}.${hash}.${bytesToB64url(signature)}`;
}

export function freshNonce() {
	return bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
}

async function materialFromSeed(
	seed: Uint8Array<ArrayBuffer>,
	publicKey: Uint8Array<ArrayBuffer>,
) {
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
	if (!matches) {
		throw new Error("Library identity does not match its public key");
	}
	return { privateCryptoKey, publicKey };
}

async function hkdf(seed: Uint8Array<ArrayBuffer>, info: string) {
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
