/**
 * SECURITY CRITICAL: the only production boundary that deliberately handles the
 * shared library seed or seed-bearing credential plaintext.
 *
 * Audit callers with: rg 'library-identity' client/src
 * Allowed owners: session orchestration and pairing crypto. Consumers receive
 * opaque identities, non-extractable key handles, public data, or ciphertext.
 * Never add a seed getter, JSON credential export, or plaintext callback here.
 * This is an audit boundary, not a sandbox against arbitrary application code.
 */
import {
	b64urlToBytes,
	bytesToB64url,
	concat,
	hexToBytes,
	utf8,
} from "../protocol/bytes.ts";
import type { Bytes } from "../protocol/chain.ts";
import type { SigningKey } from "../protocol/crypto.ts";
import { decode, encode } from "../protocol/msgpack.ts";
import {
	openBytes,
	passwordOpen,
	passwordSeal,
	sealBytes,
} from "../protocol/password.ts";
import { checkServer } from "../protocol/server.ts";

export interface TrustedCheckpoint {
	readonly sequence: number;
	readonly hash: string;
}
export type SealedCredentials = readonly [1, Bytes, Bytes];
export type LibraryIdentity = Pick<
	LibraryIdentityImpl,
	keyof LibraryIdentityImpl
>;
export interface OpenedIdentity {
	readonly identity: LibraryIdentity;
	readonly checkpoint: TrustedCheckpoint;
}
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const LOCAL_PURPOSE = "i2nclip/local-library/1";
const BACKUP_PURPOSE = "i2nclip/library-backup/1";
const PKCS8 = hexToBytes("302e020100300506032b657004220420");
const identities = new WeakMap<LibraryIdentity, LibraryIdentityImpl>();
function invalid(): never {
	throw new Error("Invalid library credentials.");
}
function binary(value: unknown, length: number): Bytes {
	if (!(value instanceof Uint8Array) || value.length !== length) {
		invalid();
	}
	return new Uint8Array(value);
}
function checkpoint(value: unknown): TrustedCheckpoint {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!Number.isSafeInteger(value[0]) ||
		value[0] < 0
	) {
		invalid();
	}
	const hash = binary(value[1], 32);
	return {
		sequence: value[0],
		hash: Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(""),
	};
}
async function digest(value: Bytes) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}
function owned(identity: LibraryIdentity) {
	const owner = identities.get(identity);
	if (!owner) {
		invalid();
	}
	return owner;
}
export function createLibraryIdentity(
	origin: string,
	signal: AbortSignal,
): Promise<OpenedIdentity> {
	return LibraryIdentityImpl.create(origin, signal);
}
export async function openLocalIdentity(
	sealed: unknown,
	key: CryptoKey,
	signal: AbortSignal,
): Promise<OpenedIdentity | null> {
	const plaintext = await openBytes(key, sealed, LOCAL_PURPOSE);
	try {
		if (plaintext.length === 1 && plaintext[0] === 0xc0) {
			signal.throwIfAborted();
			return null;
		}
		return await LibraryIdentityImpl.open(plaintext, signal);
	} finally {
		plaintext.fill(0);
	}
}
export async function openLibraryBackup(
	bytes: Bytes,
	password: string,
	signal: AbortSignal,
): Promise<OpenedIdentity> {
	if (bytes.length > MAX_CREDENTIAL_BYTES) {
		invalid();
	}
	const frame = decode(bytes);
	if (
		!Array.isArray(frame) ||
		frame.length !== 3 ||
		frame[0] !== "i2nclip-library-backup" ||
		frame[1] !== 1 ||
		!equal(encode(frame), bytes)
	) {
		invalid();
	}
	const plaintext = await passwordOpen(frame[2], password, BACKUP_PURPOSE);
	try {
		return await LibraryIdentityImpl.open(plaintext, signal);
	} finally {
		plaintext.fill(0);
	}
}
export async function openPairingIdentity(
	packet: Bytes,
	key: CryptoKey,
	context: string,
	signal: AbortSignal,
) {
	if (packet.length > MAX_CREDENTIAL_BYTES) {
		invalid();
	}
	const envelope = decode(packet);
	if (!equal(encode(envelope), packet)) {
		invalid();
	}
	const plaintext = await openBytes(key, envelope, `${context} transfer 4`);
	try {
		const frame = decode(plaintext);
		if (
			!Array.isArray(frame) ||
			frame.length !== 3 ||
			frame[0] !== 1 ||
			!equal(encode(frame), plaintext)
		) {
			invalid();
		}
		const challenge = binary(frame[2], 32);
		const credential = encode(frame[1]);
		try {
			return {
				...(await LibraryIdentityImpl.open(credential, signal)),
				challenge,
			};
		} finally {
			credential.fill(0);
			if (Array.isArray(frame[1]) && frame[1][3] instanceof Uint8Array) {
				frame[1][3].fill(0);
			}
		}
	} finally {
		plaintext.fill(0);
	}
}
export async function sealEmptyLocalIdentity(
	key: CryptoKey,
	signal: AbortSignal,
): Promise<SealedCredentials> {
	signal.throwIfAborted();
	const sealed = await sealBytes(key, encode(null), LOCAL_PURPOSE);
	signal.throwIfAborted();
	return sealed;
}
export function sealLocalIdentity(
	identity: LibraryIdentity,
	head: TrustedCheckpoint,
	key: CryptoKey,
	signal: AbortSignal,
) {
	return owned(identity).sealLocal(head, key, signal);
}
export function sealLibraryBackup(
	identity: LibraryIdentity,
	head: TrustedCheckpoint,
	signal: AbortSignal,
) {
	return owned(identity).sealBackup(head, signal);
}
export function sealPairingIdentity(
	identity: LibraryIdentity,
	head: TrustedCheckpoint,
	challenge: Bytes,
	key: CryptoKey,
	context: string,
	signal: AbortSignal,
) {
	return owned(identity).sealTransfer(head, challenge, key, context, signal);
}
class LibraryIdentityImpl {
	#seed: Bytes;
	private disposed = false;
	readonly origin: string;
	readonly genesis: Bytes;
	readonly library: Bytes;
	readonly signing: SigningKey;
	readonly encryption: CryptoKey;
	readonly dispose = this.disposeIdentity.bind(this);
	private constructor(
		seed: Bytes,
		origin: string,
		genesis: Bytes,
		library: Bytes,
		signing: SigningKey,
		encryption: CryptoKey,
	) {
		this.#seed = seed;
		this.origin = origin;
		this.genesis = genesis;
		this.library = library;
		this.signing = signing;
		this.encryption = encryption;
	}
	private static async load(
		seed: Bytes,
		origin: string,
		genesis: Bytes,
		signal: AbortSignal,
	): Promise<OpenedIdentity> {
		try {
			signal.throwIfAborted();
			checkServer(origin);
			if (new URL(origin).origin !== origin) {
				invalid();
			}
			const frame = decode(genesis);
			if (
				!Array.isArray(frame) ||
				frame.length !== 2 ||
				frame[0] !== 1 ||
				!equal(encode(frame), genesis)
			) {
				invalid();
			}
			const publicKey = binary(frame[1], 32);
			const library = await digest(
				concat([utf8("i2nclip/chain/genesis/1\n"), genesis]),
			);
			const pkcs8 = concat([PKCS8, seed]);
			let privateCryptoKey: CryptoKey;
			try {
				privateCryptoKey = await crypto.subtle.importKey(
					"pkcs8",
					pkcs8,
					"Ed25519",
					false,
					["sign"],
				);
			} finally {
				pkcs8.fill(0);
			}
			const publicCryptoKey = await crypto.subtle.importKey(
				"raw",
				publicKey,
				"Ed25519",
				false,
				["verify"],
			);
			const probe = utf8("i2nclip/library-identity/1");
			const signature = await crypto.subtle.sign(
				"Ed25519",
				privateCryptoKey,
				probe,
			);
			if (
				!(await crypto.subtle.verify(
					"Ed25519",
					publicCryptoKey,
					signature,
					probe,
				))
			) {
				invalid();
			}
			const material = await crypto.subtle.importKey(
				"raw",
				seed,
				"HKDF",
				false,
				["deriveBits"],
			);
			const root = new Uint8Array(
				await crypto.subtle.deriveBits(
					{
						name: "HKDF",
						hash: "SHA-256",
						salt: utf8("i2nclip"),
						info: encode(["i2nclip/library-encryption/1", library]),
					},
					material,
					256,
				),
			);
			let encryption: CryptoKey;
			try {
				encryption = await crypto.subtle.importKey("raw", root, "HKDF", false, [
					"deriveKey",
				]);
			} finally {
				root.fill(0);
			}
			signal.throwIfAborted();
			const identity = new LibraryIdentityImpl(
				seed,
				origin,
				genesis.slice(),
				library,
				{
					privateCryptoKey,
					publicKey,
					registrationKey: bytesToB64url(publicKey),
				},
				encryption,
			);
			identities.set(identity, identity);
			return { identity, checkpoint: { sequence: 0, hash: hex(library) } };
		} catch (error) {
			seed.fill(0);
			throw error;
		}
	}
	static async create(origin: string, signal: AbortSignal) {
		signal.throwIfAborted();
		const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign"]);
		const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
		if (!jwk.d || !jwk.x) {
			invalid();
		}
		return LibraryIdentityImpl.load(
			b64urlToBytes(jwk.d),
			origin,
			encode([1, b64urlToBytes(jwk.x)]),
			signal,
		);
	}
	static async open(
		plaintext: Bytes,
		signal: AbortSignal,
	): Promise<OpenedIdentity> {
		if (plaintext.length > MAX_CREDENTIAL_BYTES) {
			invalid();
		}
		const frame = decode(plaintext);
		try {
			if (
				!Array.isArray(frame) ||
				frame.length !== 5 ||
				frame[0] !== 1 ||
				typeof frame[1] !== "string" ||
				!(frame[2] instanceof Uint8Array) ||
				frame[2].length > 128 ||
				!equal(encode(frame), plaintext)
			) {
				invalid();
			}
			const head = checkpoint(frame[4]);
			const opened = await LibraryIdentityImpl.load(
				binary(frame[3], 32),
				frame[1],
				new Uint8Array(frame[2]),
				signal,
			);
			if (head.sequence === 0 && head.hash !== hex(opened.identity.library)) {
				opened.identity.dispose();
				invalid();
			}
			return { ...opened, checkpoint: head };
		} finally {
			if (Array.isArray(frame) && frame[3] instanceof Uint8Array) {
				frame[3].fill(0);
			}
		}
	}
	private check(signal: AbortSignal) {
		signal.throwIfAborted();
		if (this.disposed) {
			throw new Error("Library identity is closed.");
		}
	}
	private credentials(head: TrustedCheckpoint) {
		if (
			!/^[0-9a-f]{64}$/.test(head.hash) ||
			!Number.isSafeInteger(head.sequence) ||
			head.sequence < 0 ||
			(head.sequence === 0 && head.hash !== hex(this.library))
		) {
			invalid();
		}
		return [
			1,
			this.origin,
			this.genesis,
			this.#seed,
			[head.sequence, hexToBytes(head.hash)],
		];
	}
	async sealLocal(
		head: TrustedCheckpoint,
		key: CryptoKey,
		signal: AbortSignal,
	): Promise<SealedCredentials> {
		this.check(signal);
		const plaintext = encode(this.credentials(head));
		try {
			const sealed = await sealBytes(key, plaintext, LOCAL_PURPOSE);
			this.check(signal);
			return sealed;
		} finally {
			plaintext.fill(0);
		}
	}
	async sealBackup(head: TrustedCheckpoint, signal: AbortSignal) {
		this.check(signal);
		const plaintext = encode(this.credentials(head));
		const random = crypto.getRandomValues(new Uint8Array(32));
		const password = bytesToB64url(random);
		random.fill(0);
		try {
			const sealed = await passwordSeal(plaintext, password, BACKUP_PURPOSE);
			this.check(signal);
			return { bytes: encode(["i2nclip-library-backup", 1, sealed]), password };
		} finally {
			plaintext.fill(0);
		}
	}
	async sealTransfer(
		head: TrustedCheckpoint,
		challenge: Bytes,
		key: CryptoKey,
		context: string,
		signal: AbortSignal,
	) {
		this.check(signal);
		const plaintext = encode([
			1,
			this.credentials(head),
			binary(challenge, 32),
		]);
		try {
			const sealed = await sealBytes(key, plaintext, `${context} transfer 4`);
			this.check(signal);
			return encode(sealed);
		} finally {
			plaintext.fill(0);
		}
	}
	private disposeIdentity() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.#seed.fill(0);
		identities.delete(this);
	}
}
function hex(value: Bytes) {
	return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
}
function equal(left: Bytes, right: Bytes) {
	return left.length === right.length && left.every((b, i) => b === right[i]);
}
