import { concat, utf8 } from "./bytes.ts";
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
export type Effects =
	| readonly StorageEffect[]
	| readonly [Bytes]
	| readonly [number, Bytes, Bytes];
export type BlockKind = "data" | "enroll" | "revoke" | "rotate";
export interface BlockHeader {
	readonly library: Bytes;
	readonly sequence: number;
	readonly previous: Bytes;
	readonly epoch: number;
	readonly signer: Bytes;
	readonly kind: BlockKind;
	readonly effects: Effects;
}
export interface BlockBody extends BlockHeader {
	readonly salt: Bytes | null;
	readonly nonce: Bytes | null;
	readonly encrypted: Bytes | null;
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
function parseBody(input: unknown): BlockBody {
	if (!Array.isArray(input) || input.length !== 11 || input[0] !== 1) {
		invalid();
	}
	const kind = input[6];
	let effects: Effects;
	if (kind === "data") {
		if (!Array.isArray(input[7]) || input[7].length > 1) {
			invalid();
		}
		effects = input[7].map(storageEffect);
		fixedBytes(input[8]);
		fixedBytes(input[9], 12);
		if (!(input[10] instanceof Uint8Array) || input[10].length < 16) {
			invalid();
		}
	} else {
		if (input[8] !== null || input[9] !== null || input[10] !== null) {
			invalid();
		}
		if (!Array.isArray(input[7])) {
			invalid();
		}
		if ((kind === "enroll" || kind === "revoke") && input[7].length === 1) {
			effects = [fixedBytes(input[7][0])];
		} else if (kind === "rotate" && input[7].length === 3) {
			effects = [
				safeInteger(input[7][0], 2),
				fixedBytes(input[7][1]),
				fixedBytes(input[7][2]),
			];
		} else {
			return invalid();
		}
	}
	return {
		library: fixedBytes(input[1]),
		sequence: safeInteger(input[2], 1),
		previous: fixedBytes(input[3]),
		epoch: safeInteger(input[4], 1),
		signer: fixedBytes(input[5]),
		kind,
		effects,
		salt: kind === "data" ? fixedBytes(input[8]) : null,
		nonce: kind === "data" ? fixedBytes(input[9], 12) : null,
		encrypted: kind === "data" ? new Uint8Array(input[10]) : null,
	};
}
export function headerValues(body: BlockBody): unknown[] {
	return [
		1,
		body.library,
		body.sequence,
		body.previous,
		body.epoch,
		body.signer,
		body.kind,
		body.effects,
		body.salt,
		body.nonce,
	];
}
function bodyBytes(body: BlockBody) {
	return encode([...headerValues(body), body.encrypted]);
}
export async function sha256(bytes: Bytes): Promise<Bytes> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
export async function genesis(
	recoveryPublicKey: Bytes,
	initialPublicKey: Bytes,
	epochSalt: Bytes,
) {
	if (sameBytes(recoveryPublicKey, initialPublicKey)) {
		throw new Error(
			"Recovery authority must be separate from the initial device.",
		);
	}
	const document = encode([
		1,
		fixedBytes(recoveryPublicKey),
		fixedBytes(initialPublicKey),
		fixedBytes(epochSalt),
		1,
	]);
	return {
		bytes: document,
		hash: await genesisHash(document),
	};
}
export function genesisHash(document: Bytes) {
	return sha256(concat([GENESIS_DOMAIN, document]));
}
export async function verifyRecord(input: Bytes): Promise<VerifiedBlock> {
	if (input.length > MAX_BLOCK_BYTES) {
		invalid();
	}
	const wire = decode(input);
	if (!Array.isArray(wire) || wire.length !== 2) {
		invalid();
	}
	if (!(wire[0] instanceof Uint8Array)) {
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
		body.signer,
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
async function blockKey(secret: Bytes, body: BlockBody) {
	if (!body.salt) {
		invalid();
	}
	const material = await crypto.subtle.importKey(
		"raw",
		fixedBytes(secret),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: body.salt,
			info: encode(["i2nclip/chain/key/1", body.library, body.epoch]),
		},
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}
function encryptionParameters(body: BlockBody) {
	if (!body.nonce) {
		invalid();
	}
	return {
		name: "AES-GCM",
		iv: body.nonce,
		additionalData: concat([AAD_DOMAIN, encode(headerValues(body))]),
	};
}
export async function createRecord(
	header: BlockHeader,
	key: CryptoKey,
	privateOperation?: { secret: Bytes; plaintext: Bytes },
): Promise<VerifiedBlock> {
	const body: BlockBody = {
		...header,
		salt:
			header.kind === "data"
				? crypto.getRandomValues(new Uint8Array(32))
				: null,
		nonce:
			header.kind === "data"
				? crypto.getRandomValues(new Uint8Array(12))
				: null,
		encrypted: header.kind === "data" ? new Uint8Array(16) : null,
	};
	parseBody([...headerValues(body), body.encrypted]);
	if (header.kind === "data") {
		if (
			!privateOperation ||
			privateOperation.plaintext.length > MAX_BLOCK_BYTES - 1024
		) {
			invalid();
		}
		const encrypted = new Uint8Array(
			await crypto.subtle.encrypt(
				encryptionParameters(body),
				await blockKey(privateOperation.secret, body),
				privateOperation.plaintext,
			),
		);
		return signBody({ ...body, encrypted }, key);
	}
	if (privateOperation) {
		invalid();
	}
	return signBody(body, key);
}
async function signBody(body: BlockBody, key: CryptoKey) {
	const signed = bodyBytes(body);
	const signature = new Uint8Array(
		await crypto.subtle.sign("Ed25519", key, concat([SIGN_DOMAIN, signed])),
	);
	return verifyRecord(encode([signed, signature]));
}
export async function decryptOperation(record: VerifiedBlock, secret: Bytes) {
	if (record.body.kind !== "data" || !record.body.encrypted) {
		invalid();
	}
	return new Uint8Array(
		await crypto.subtle.decrypt(
			encryptionParameters(record.body),
			await blockKey(secret, record.body),
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
