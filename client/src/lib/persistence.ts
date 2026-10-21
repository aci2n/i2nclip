import { createDatabase, type Database } from "./database.ts";
import { decode, encode } from "./protocol/msgpack.ts";
import {
	openBytes,
	PBKDF2_ITERATIONS,
	sealBytes,
	wrappingKey,
} from "./protocol/password.ts";

export interface SavedIdentity {
	readonly revision: string;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly iterations: number;
	readonly encrypted: unknown;
	readonly key?: CryptoKey;
}
const SESSION = "session";
const PURPOSE = "i2nclip/local-identity/1";
export function createPersistence(
	database: Database = createDatabase(),
): Pick<PersistenceImpl, keyof PersistenceImpl> {
	return new PersistenceImpl(database);
}
class PersistenceImpl {
	private readonly database: Database;
	readonly read = this.readSaved.bind(this);
	readonly open = this.openSaved.bind(this);
	readonly passwordKey = this.derivePasswordKey.bind(this);
	readonly protect = this.protectIdentity.bind(this);
	readonly save = this.saveIdentity.bind(this);
	readonly remember = this.rememberKey.bind(this);
	readonly lock = this.lockIdentity.bind(this);
	readonly reset = this.resetIdentity.bind(this);
	readonly dispose = this.disposePersistence.bind(this);
	constructor(database: Database) {
		this.database = database;
	}
	private async readSaved(signal: AbortSignal): Promise<SavedIdentity | null> {
		const value = await this.database.read<SavedIdentity>(SESSION, signal);
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
				"Invalid saved identity. Reset this client, then re-pair or restore the offline recovery file.",
			);
		}
		return value;
	}
	private async openSaved(
		saved: SavedIdentity,
		key: CryptoKey,
		signal: AbortSignal,
	) {
		let plaintext: Uint8Array<ArrayBuffer> | undefined;
		try {
			plaintext = await openBytes(key, saved.encrypted, PURPOSE);
			const identity: unknown = structuredClone(decode(plaintext));
			signal.throwIfAborted();
			return identity;
		} catch {
			signal.throwIfAborted();
			throw new Error("Wrong password or damaged saved identity.");
		} finally {
			plaintext?.fill(0);
		}
	}
	private async derivePasswordKey(
		saved: SavedIdentity,
		password: string,
		signal: AbortSignal,
	) {
		const key = await wrappingKey(password, saved.salt, PBKDF2_ITERATIONS);
		signal.throwIfAborted();
		return key;
	}
	private async replace(
		expected: SavedIdentity | null,
		next: SavedIdentity | undefined,
		signal: AbortSignal,
	) {
		await this.database.update<SavedIdentity>(
			SESSION,
			(current) => {
				if ((current?.revision ?? null) !== (expected?.revision ?? null)) {
					throw new Error(
						"Saved session changed in another tab. Refresh this client and try again.",
					);
				}
				return next;
			},
			signal,
		);
	}
	private async write(
		expected: SavedIdentity | null,
		salt: Uint8Array<ArrayBuffer>,
		key: CryptoKey,
		identity: unknown,
		signal: AbortSignal,
		remember: boolean,
	) {
		const plaintext = encode(identity);
		try {
			const encrypted = await sealBytes(key, plaintext, PURPOSE);
			signal.throwIfAborted();
			const saved: SavedIdentity = {
				revision: crypto.randomUUID(),
				salt,
				iterations: PBKDF2_ITERATIONS,
				encrypted,
				...(remember ? { key } : {}),
			};
			await this.replace(expected, saved, signal);
			return saved;
		} finally {
			plaintext.fill(0);
		}
	}
	private async protectIdentity(
		expected: SavedIdentity | null,
		password: string,
		identity: unknown,
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
			saved: await this.write(expected, salt, key, identity, signal, remember),
			key,
		};
	}
	private saveIdentity(
		saved: SavedIdentity,
		key: CryptoKey,
		identity: unknown,
		signal: AbortSignal,
	) {
		return this.write(
			saved,
			saved.salt,
			key,
			identity,
			signal,
			identity !== null && Boolean(saved.key),
		);
	}
	private async rememberKey(
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
		await this.replace(saved, next, signal);
		return next;
	}
	private async lockIdentity(signal: AbortSignal) {
		return (
			(await this.database.update<SavedIdentity>(
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
	}
	private resetIdentity(signal: AbortSignal) {
		return this.database.update<SavedIdentity>(
			SESSION,
			() => undefined,
			signal,
		);
	}
	private disposePersistence() {
		this.database.dispose();
	}
}
