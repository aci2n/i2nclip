import {
	bytesToB64url,
	bytesToHex,
	concat,
	hexToBytes,
	utf8,
} from "./bytes.ts";
import { parsePrivateKey } from "./identity.ts";
export interface SigningKey {
	readonly privateCryptoKey: CryptoKey;
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

/**
 * Load an internal library identity document.
 * Returns the public key to register on the server, plus handles the
 * protocol operations can use without parsing again.
 */
export async function loadSigningKey(privateKey: unknown): Promise<SigningKey> {
	const parsed = parsePrivateKey(privateKey);
	try {
		const { privateCryptoKey } = await materialFromSeed(
			parsed.seed,
			parsed.publicKey,
		);
		return Object.freeze({
			privateCryptoKey,
			publicKey: parsed.publicKey,
			registrationKey: bytesToB64url(parsed.publicKey),
		});
	} finally {
		parsed.seed.fill(0);
	}
}

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
	key: SigningKey;
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
