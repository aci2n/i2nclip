import { b64ToBytes, bytesToB64 } from "./protocol/bytes.ts";
import { decode, encode } from "./protocol/msgpack.ts";
import {
	openBytes,
	PBKDF2_ITERATIONS,
	sealBytes,
	wrappingKey,
} from "./protocol/password.ts";
import type { Identity } from "./protocol/recovery.ts";
import { bytes as binary, document } from "./protocol/value.ts";

export interface LocalStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}
export interface SavedIdentity {
	readonly text: string;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly encrypted: unknown;
}
export const IDENTITY_STORAGE_KEY = "i2nclip.identity";
const PURPOSE = "i2nclip/local-identity/1";

// Storage contains ciphertext only. The session owns all live key references.
export function createPersistence(storage?: LocalStorage) {
	const local = () => storage ?? globalThis.localStorage;
	const text = () => local().getItem(IDENTITY_STORAGE_KEY);
	function unchanged(expected: string | null) {
		if (text() !== expected) {
			throw new Error(
				"Saved identity changed in another tab. Unlock this client again.",
			);
		}
	}
	function read(): SavedIdentity | null {
		const saved = text();
		if (saved === null) {
			return null;
		}
		const value = document(decode(b64ToBytes(saved)));
		if (
			value.v !== 1 ||
			value.iterations !== PBKDF2_ITERATIONS ||
			!(value.salt instanceof Uint8Array) ||
			value.salt.length !== 16
		) {
			throw new Error(
				"Invalid saved identity. Reset this client or restore a recovery file.",
			);
		}
		return {
			text: saved,
			salt: binary(value.salt),
			encrypted: value.encrypted,
		};
	}
	async function open(
		saved: SavedIdentity,
		key: CryptoKey,
		signal: AbortSignal,
	) {
		let identity: unknown;
		try {
			identity = decode(await openBytes(key, saved.encrypted, PURPOSE));
		} catch {
			signal.throwIfAborted();
			throw new Error("Wrong password or damaged saved identity.");
		}
		signal.throwIfAborted();
		unchanged(saved.text);
		return identity;
	}
	async function passwordKey(
		saved: SavedIdentity,
		password: string,
		signal: AbortSignal,
	) {
		const key = await wrappingKey(password, saved.salt, PBKDF2_ITERATIONS);
		signal.throwIfAborted();
		return key;
	}
	async function write(
		expected: string | null,
		salt: Uint8Array<ArrayBuffer>,
		key: CryptoKey,
		identity: Identity | null,
		signal: AbortSignal,
	): Promise<SavedIdentity> {
		const encrypted = await sealBytes(key, encode(identity), PURPOSE);
		signal.throwIfAborted();
		const saved = bytesToB64(
			encode({ v: 1, iterations: PBKDF2_ITERATIONS, salt, encrypted }),
		);
		unchanged(expected);
		local().setItem(IDENTITY_STORAGE_KEY, saved);
		return { text: saved, salt, encrypted };
	}
	async function protect(
		expected: string | null,
		password: string,
		identity: Identity | null,
		signal: AbortSignal,
	) {
		if (password.length < 8) {
			throw new Error("Master password must be at least 8 characters.");
		}
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const key = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
		signal.throwIfAborted();
		const saved = await write(expected, salt, key, identity, signal);
		return { saved, key };
	}
	return {
		text,
		read,
		unchanged,
		open,
		passwordKey,
		protect,
		save: (
			saved: SavedIdentity,
			key: CryptoKey,
			identity: Identity | null,
			signal: AbortSignal,
		) => write(saved.text, saved.salt, key, identity, signal),
		reset(expected: string | null) {
			unchanged(expected);
			local().removeItem(IDENTITY_STORAGE_KEY);
		},
		ownsStorage: (area: unknown) => area === local(),
	};
}
