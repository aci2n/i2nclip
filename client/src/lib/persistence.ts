import { createDatabase, type Database } from "./database.ts";
import { decode, encode } from "./protocol/msgpack.ts";
import {
	openBytes,
	PBKDF2_ITERATIONS,
	sealBytes,
	wrappingKey,
} from "./protocol/password.ts";
import type { Identity } from "./protocol/recovery.ts";

export interface SavedIdentity {
	readonly revision: string;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly iterations: number;
	readonly encrypted: unknown;
	readonly key?: CryptoKey;
}
const SESSION = "session";
const PURPOSE = "i2nclip/local-identity/1";

export function createPersistence(database: Database = createDatabase()) {
	function unchanged(
		current: SavedIdentity | undefined,
		expected: SavedIdentity | null,
	) {
		if ((current?.revision ?? null) !== (expected?.revision ?? null)) {
			throw new Error(
				"Saved session changed in another tab. Refresh this client and try again.",
			);
		}
	}
	async function read(signal: AbortSignal): Promise<SavedIdentity | null> {
		const value = await database.read<SavedIdentity>(SESSION, signal);
		if (value === undefined) {
			return null;
		}
		if (
			typeof value?.revision !== "string" ||
			value.iterations !== PBKDF2_ITERATIONS ||
			!(value.salt instanceof Uint8Array) ||
			value.salt.length !== 16
		) {
			throw new Error(
				"Invalid saved identity. Reset this client or restore a recovery file.",
			);
		}
		return value;
	}
	async function open(
		saved: SavedIdentity,
		key: CryptoKey,
		signal: AbortSignal,
	) {
		try {
			const identity = decode(await openBytes(key, saved.encrypted, PURPOSE));
			signal.throwIfAborted();
			return identity;
		} catch {
			signal.throwIfAborted();
			throw new Error("Wrong password or damaged saved identity.");
		}
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
	async function replace(
		expected: SavedIdentity | null,
		next: SavedIdentity | undefined,
		signal: AbortSignal,
	) {
		await database.update<SavedIdentity>(
			SESSION,
			(current) => {
				unchanged(current, expected);
				return next;
			},
			signal,
		);
	}
	async function write(
		expected: SavedIdentity | null,
		salt: Uint8Array<ArrayBuffer>,
		key: CryptoKey,
		identity: Identity | null,
		signal: AbortSignal,
		remember: boolean,
	) {
		const encrypted = await sealBytes(key, encode(identity), PURPOSE);
		signal.throwIfAborted();
		const saved: SavedIdentity = {
			revision: crypto.randomUUID(),
			salt,
			iterations: PBKDF2_ITERATIONS,
			encrypted,
			...(remember ? { key } : {}),
		};
		await replace(expected, saved, signal);
		return saved;
	}
	return {
		read,
		open,
		passwordKey,
		async protect(
			expected: SavedIdentity | null,
			password: string,
			identity: Identity | null,
			signal: AbortSignal,
			remember = false,
		) {
			if (password.length < 8) {
				throw new Error("Master password must be at least 8 characters.");
			}
			const salt = crypto.getRandomValues(new Uint8Array(16));
			const key = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
			signal.throwIfAborted();
			return {
				saved: await write(expected, salt, key, identity, signal, remember),
				key,
			};
		},
		save: (
			saved: SavedIdentity,
			key: CryptoKey,
			identity: Identity | null,
			signal: AbortSignal,
		) =>
			write(
				saved,
				saved.salt,
				key,
				identity,
				signal,
				identity !== null && Boolean(saved.key),
			),
		async remember(
			saved: SavedIdentity,
			key: CryptoKey | null,
			signal: AbortSignal,
		) {
			const next: SavedIdentity = {
				revision: crypto.randomUUID(),
				salt: saved.salt,
				iterations: saved.iterations,
				encrypted: saved.encrypted,
				...(key ? { key } : {}),
			};
			await replace(saved, next, signal);
			return next;
		},
		async lock(signal: AbortSignal) {
			// Lock always clears the current remembered key, even for an older tab.
			return (
				(await database.update<SavedIdentity>(
					SESSION,
					(saved) =>
						saved
							? {
									revision: crypto.randomUUID(),
									salt: saved.salt,
									iterations: saved.iterations,
									encrypted: saved.encrypted,
								}
							: undefined,
					signal,
				)) ?? null
			);
		},
		reset: (signal: AbortSignal) =>
			database.update<SavedIdentity>(SESSION, () => undefined, signal),
		dispose: database.dispose,
	};
}
