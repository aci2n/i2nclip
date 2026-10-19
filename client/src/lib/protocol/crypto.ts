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
export interface LoadedKey {
	readonly privateCryptoKey: CryptoKey;
	readonly fileKeyMaterial: CryptoKey;
	readonly tagLabelKey: CryptoKey;
	readonly tagTokenKey: CryptoKey;
	readonly publicKey: Uint8Array<ArrayBuffer>;
	readonly registrationKey: string;
}
interface RequestContext {
	origin: string;
	ts: number;
	nonce: string;
	method: string;
	path: string;
}
interface RequestMessage extends RequestContext {
	hash: string;
}

// Shared protocol vectors are produced by the test-only Rust reference client.
const PKCS8_PREFIX = hexToBytes("302e020100300506032b657004220420");

function fileContext(purpose: "metadata" | "descriptor", id: string) {
	if (!/^[0-9a-f]{64}$/.test(id)) {
		throw new Error("Invalid content identifier.");
	}
	return `i2nclip/keys/v1/${purpose}/${id}`;
}

export async function sealMetadata(
	material: CryptoKey,
	id: string,
	plain: Uint8Array<ArrayBuffer>,
) {
	const key = await deriveAes(material, fileContext("metadata", id));
	return encrypt(key, utf8(`i2nclip/v1 meta ${id}`), plain);
}

export async function openMetadata(
	material: CryptoKey,
	id: string,
	blob: Uint8Array,
) {
	const key = await deriveAes(material, fileContext("metadata", id));
	return decrypt(key, utf8(`i2nclip/v1 meta ${id}`), blob);
}

export async function sealDescriptorBytes(
	material: CryptoKey,
	id: string,
	plain: Uint8Array<ArrayBuffer>,
) {
	const key = await deriveAes(material, fileContext("descriptor", id));
	return encrypt(key, utf8(`i2nclip/v2 descriptor ${id}`), plain);
}

export async function openDescriptorBytes(
	material: CryptoKey,
	id: string,
	blob: Uint8Array,
) {
	const key = await deriveAes(material, fileContext("descriptor", id));
	return decrypt(key, utf8(`i2nclip/v2 descriptor ${id}`), blob);
}

export function sealTagLabel(
	key: CryptoKey,
	token: string,
	plain: Uint8Array<ArrayBuffer>,
) {
	return encrypt(key, utf8(`i2nclip/v1 tag ${token}`), plain);
}

export function openTagLabel(key: CryptoKey, token: string, blob: Uint8Array) {
	return decrypt(key, utf8(`i2nclip/v1 tag ${token}`), blob);
}

/**
 * Load an internal library identity document.
 * Returns the public key to register on the server, plus handles the
 * protocol operations can use without parsing again.
 */
export async function loadKey(privateKey: unknown): Promise<LoadedKey> {
	const parsed = parsePrivateKey(privateKey);
	try {
		const { privateCryptoKey } = await materialFromSeed(
			parsed.seed,
			parsed.publicKey,
		);
		const fileKeyMaterial = await crypto.subtle.importKey(
			"raw",
			parsed.seed,
			"HKDF",
			false,
			["deriveKey"],
		);
		const tagLabelKey = await deriveAes(
			fileKeyMaterial,
			"i2nclip/keys/v1/tag-label",
		);
		const tagTokenKey = await crypto.subtle.deriveKey(
			hkdf("i2nclip/keys/v1/tag-token"),
			fileKeyMaterial,
			{ name: "HMAC", hash: "SHA-256", length: 256 },
			false,
			["sign"],
		);
		return Object.freeze({
			privateCryptoKey,
			fileKeyMaterial,
			tagLabelKey,
			tagTokenKey,
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
			key.tagTokenKey,
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
async function encrypt(
	key: CryptoKey,
	aad: Uint8Array<ArrayBuffer>,
	plaintext: Uint8Array<ArrayBuffer>,
) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: aad },
			key,
			plaintext,
		),
	);
	return encode({ v: 1, iv, ct });
}

async function decrypt(
	key: CryptoKey,
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
			key,
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
}: RequestContext & {
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
	let privateCryptoKey: CryptoKey;
	try {
		privateCryptoKey = await crypto.subtle.importKey(
			"pkcs8",
			pkcs8,
			{ name: "Ed25519" },
			false,
			["sign"],
		);
	} finally {
		pkcs8.fill(0);
	}

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

function hkdf(info: string): HkdfParams {
	return {
		name: "HKDF",
		hash: "SHA-256",
		salt: utf8("i2nclip"),
		info: utf8(info),
	};
}

function deriveAes(material: CryptoKey, info: string) {
	return crypto.subtle.deriveKey(
		hkdf(info),
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}
