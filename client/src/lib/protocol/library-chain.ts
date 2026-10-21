import { concat, utf8 } from "./bytes.ts";
import type { SigningKey } from "./crypto.ts";
import { decode, encode } from "./msgpack.ts";
export type Bytes = Uint8Array<ArrayBuffer>;
export const MAX_BLOCK_BYTES = 64 * 1024;
export const MAX_BLOB_BYTES = 4 * 1024 * 1024 + 64;
export const MAX_PAGE_BYTES = 1024 * 1024;
export const MAX_PAGE_BLOCKS = 128;
export const MAX_PURGE_FILES = 256;
export const SIGN_DOMAIN = utf8("i2nclip/chain/sign/1\n");
const BLOCK_DOMAIN = utf8("i2nclip/chain/block/1\n");
const GENESIS_DOMAIN = utf8("i2nclip/chain/genesis/1\n");
const AAD_DOMAIN = utf8("i2nclip/chain/aad/1\n");
export type StorageEffect =
	| readonly ["publish", Bytes, Bytes]
	| readonly ["commit", Bytes, readonly Bytes[]]
	| readonly ["purge", readonly Bytes[]];
export type Effects = readonly StorageEffect[];
export interface BlockHeader {
	readonly library: Bytes;
	readonly sequence: number;
	readonly previous: Bytes;
	readonly effects: Effects;
}
export interface BlockBody extends BlockHeader {
	readonly salt: Bytes;
	readonly nonce: Bytes;
	readonly encrypted: Bytes;
}
export interface VerifiedBlock {
	readonly bytes: Bytes;
	readonly hash: Bytes;
	readonly body: BlockBody;
}
function invalid(): never {
	throw new Error("Invalid chain record.");
}
export function fixedBytes(value: unknown, length = 32): Bytes {
	if (!(value instanceof Uint8Array) || value.length !== length) {
		invalid();
	}
	return new Uint8Array(value);
}
export function safeInteger(value: unknown, minimum = 0): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum
	) {
		invalid();
	}
	return value;
}
export function sameBytes(left: Uint8Array, right: Uint8Array) {
	return (
		left.length === right.length && left.every((byte, i) => byte === right[i])
	);
}
export function compareBytes(left: Uint8Array, right: Uint8Array) {
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		if (left[i] !== right[i]) {
			return left[i] - right[i];
		}
	}
	return left.length - right.length;
}
function hashList(value: unknown, maximum: number): Bytes[] {
	if (!Array.isArray(value) || !value.length || value.length > maximum) {
		invalid();
	}
	const result = value.map((item) => fixedBytes(item));
	for (let i = 1; i < result.length; i++) {
		if (compareBytes(result[i - 1], result[i]) >= 0) {
			invalid();
		}
	}
	return result;
}
function storageEffect(input: unknown): StorageEffect {
	if (!Array.isArray(input)) {
		invalid();
	}
	if (input[0] === "publish" && input.length === 3) {
		return ["publish", fixedBytes(input[1]), fixedBytes(input[2])];
	}
	if (input[0] === "commit" && input.length === 3) {
		return ["commit", fixedBytes(input[1]), hashList(input[2], 2)];
	}
	if (input[0] === "purge" && input.length === 2) {
		return ["purge", hashList(input[1], MAX_PURGE_FILES)];
	}
	return invalid();
}

export async function sha256(bytes: Bytes): Promise<Bytes> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
export function genesisHash(bytes: Bytes) {
	return sha256(concat([GENESIS_DOMAIN, bytes]));
}
export async function genesis(publicKey: Bytes) {
	const bytes = encode([1, fixedBytes(publicKey)]);
	return { bytes, hash: await genesisHash(bytes) };
}
export async function parseGenesis(bytes: Bytes) {
	if (bytes.length > 128) {
		invalid();
	}
	const value = decode(bytes);
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		value[0] !== 1 ||
		!sameBytes(encode(value), bytes)
	) {
		invalid();
	}
	const publicKey = fixedBytes(value[1]);
	await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
	return { bytes: bytes.slice(), hash: await genesisHash(bytes), publicKey };
}
function parseBody(input: unknown): BlockBody {
	if (
		!Array.isArray(input) ||
		input.length !== 8 ||
		input[0] !== 1 ||
		!Array.isArray(input[4]) ||
		input[4].length > 1 ||
		!(input[7] instanceof Uint8Array) ||
		input[7].length < 16
	) {
		invalid();
	}
	return {
		library: fixedBytes(input[1]),
		sequence: safeInteger(input[2], 1),
		previous: fixedBytes(input[3]),
		effects: input[4].map(storageEffect),
		salt: fixedBytes(input[5]),
		nonce: fixedBytes(input[6], 12),
		encrypted: new Uint8Array(input[7]),
	};
}
export function headerValues(body: BlockBody): unknown[] {
	return [
		1,
		body.library,
		body.sequence,
		body.previous,
		body.effects,
		body.salt,
		body.nonce,
	];
}
function bodyBytes(body: BlockBody) {
	return encode([...headerValues(body), body.encrypted]);
}
export async function verifyRecord(
	input: Bytes,
	publicKey: Bytes,
): Promise<VerifiedBlock> {
	if (input.length > MAX_BLOCK_BYTES) {
		invalid();
	}
	const wire = decode(input);
	if (
		!Array.isArray(wire) ||
		wire.length !== 2 ||
		!(wire[0] instanceof Uint8Array)
	) {
		invalid();
	}
	const signed = new Uint8Array(wire[0]);
	const signature = fixedBytes(wire[1], 64);
	const body = parseBody(decode(signed));
	if (
		!sameBytes(bodyBytes(body), signed) ||
		!sameBytes(encode([signed, signature]), input)
	) {
		invalid();
	}
	const key = await crypto.subtle.importKey(
		"raw",
		fixedBytes(publicKey),
		"Ed25519",
		false,
		["verify"],
	);
	if (
		!(await crypto.subtle.verify(
			"Ed25519",
			key,
			signature,
			concat([SIGN_DOMAIN, signed]),
		))
	) {
		throw new Error("Invalid chain signature.");
	}
	return {
		bytes: input.slice(),
		body,
		hash: await sha256(concat([BLOCK_DOMAIN, input])),
	};
}
async function blockKey(root: CryptoKey, body: BlockBody) {
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: body.salt,
			info: encode(["i2nclip/chain/key/1", body.library]),
		},
		root,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}
function parameters(body: BlockBody) {
	return {
		name: "AES-GCM",
		iv: body.nonce,
		additionalData: concat([AAD_DOMAIN, encode(headerValues(body))]),
	};
}
export async function createRecord(
	header: BlockHeader,
	signing: SigningKey,
	root: CryptoKey,
	plaintext: Bytes,
): Promise<VerifiedBlock> {
	const body: BlockBody = {
		...header,
		salt: crypto.getRandomValues(new Uint8Array(32)),
		nonce: crypto.getRandomValues(new Uint8Array(12)),
		encrypted: new Uint8Array(16),
	};
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt(
			parameters(body),
			await blockKey(root, body),
			plaintext,
		),
	);
	const complete = { ...body, encrypted };
	const signed = bodyBytes(complete);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"Ed25519",
			signing.privateCryptoKey,
			concat([SIGN_DOMAIN, signed]),
		),
	);
	return verifyRecord(encode([signed, signature]), signing.publicKey);
}
export async function decryptOperation(record: VerifiedBlock, root: CryptoKey) {
	return new Uint8Array(
		await crypto.subtle.decrypt(
			parameters(record.body),
			await blockKey(root, record.body),
			record.body.encrypted,
		),
	);
}
export async function inventoryDigest(
	library: Bytes,
	file: Bytes,
	entries: readonly (readonly [Bytes, number])[],
) {
	const sorted = entries
		.map(
			([hash, length]) => [fixedBytes(hash), safeInteger(length, 1)] as const,
		)
		.sort((left, right) => compareBytes(left[0], right[0]));
	for (let i = 1; i < sorted.length; i++) {
		if (sameBytes(sorted[i - 1][0], sorted[i][0])) {
			invalid();
		}
	}
	return sha256(
		encode([
			"i2nclip/inventory/1",
			fixedBytes(library),
			fixedBytes(file),
			sorted,
		]),
	);
}

export type ObjectPurpose = "manifest" | "metadata" | "thumbnail";
async function objectKey(raw: Bytes) {
	return crypto.subtle.importKey("raw", fixedBytes(raw), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}
function objectAAD(library: Bytes, file: Bytes, purpose: ObjectPurpose) {
	return encode([
		"i2nclip/object/1",
		fixedBytes(library),
		fixedBytes(file),
		purpose,
	]);
}
export async function sealObject(
	library: Bytes,
	file: Bytes,
	purpose: ObjectPurpose,
	plaintext: Bytes,
) {
	if (plaintext.length > MAX_BLOB_BYTES - 64) {
		invalid();
	}
	const rawKey = crypto.getRandomValues(new Uint8Array(32));
	try {
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{
					name: "AES-GCM",
					iv: nonce,
					additionalData: objectAAD(library, file, purpose),
				},
				await objectKey(rawKey),
				plaintext,
			),
		);
		const bytes = encode([1, nonce, ciphertext]);
		return { bytes, hash: await sha256(bytes), key: rawKey.slice() };
	} finally {
		rawKey.fill(0);
	}
}
export async function openObject(
	library: Bytes,
	file: Bytes,
	purpose: ObjectPurpose,
	hash: Bytes,
	key: Bytes,
	ciphertext: Bytes,
) {
	if (
		ciphertext.length > MAX_BLOB_BYTES ||
		!sameBytes(await sha256(ciphertext), fixedBytes(hash))
	) {
		throw new Error("Encrypted object hash mismatch.");
	}
	const envelope = decode(ciphertext);
	if (
		!Array.isArray(envelope) ||
		envelope.length !== 3 ||
		envelope[0] !== 1 ||
		!(envelope[2] instanceof Uint8Array) ||
		envelope[2].length < 16
	) {
		invalid();
	}
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: fixedBytes(envelope[1], 12),
				additionalData: objectAAD(library, file, purpose),
			},
			await objectKey(key),
			new Uint8Array(envelope[2]),
		),
	);
}
