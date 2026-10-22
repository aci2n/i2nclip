import { PBKDF2_ITERATIONS, wrappingKey } from "../protocol/password.ts";
import { createDatabase, type Database } from "./database.ts";
export interface SavedSession {
	readonly revision: string;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly iterations: number;
	readonly encrypted: unknown;
	readonly registrationPending: boolean;
	readonly key?: CryptoKey;
}
type Sealer = (key: CryptoKey) => Promise<unknown>;
export type SessionStorage = ReturnType<typeof createSessionStorage>;
export function createSessionStorage(
	database: Database = createDatabase(),
): Pick<SessionStorageImpl, keyof SessionStorageImpl> {
	return new SessionStorageImpl(database);
}
class SessionStorageImpl {
	private readonly database: Database;
	readonly read = this.readSaved.bind(this);
	readonly passwordKey = this.derivePasswordKey.bind(this);
	readonly protect = this.protectSession.bind(this);
	readonly save = this.saveSession.bind(this);
	readonly remember = this.rememberKey.bind(this);
	readonly lock = this.lockSession.bind(this);
	readonly reset = this.resetSession.bind(this);
	readonly dispose = this.disposeStorage.bind(this);
	constructor(database: Database) {
		this.database = database;
	}
	private async readSaved(signal: AbortSignal): Promise<SavedSession | null> {
		const saved = await this.database.read<SavedSession>("session", signal);
		if (!saved) {
			return null;
		}
		if (
			typeof saved.revision !== "string" ||
			saved.iterations !== PBKDF2_ITERATIONS ||
			!(saved.salt instanceof Uint8Array) ||
			saved.salt.length !== 16 ||
			typeof saved.registrationPending !== "boolean"
		) {
			throw new Error(
				"Invalid saved session. Reset this client, then connect or restore a library backup.",
			);
		}
		return saved;
	}
	private async derivePasswordKey(
		saved: SavedSession,
		password: string,
		signal: AbortSignal,
	) {
		const key = await wrappingKey(password, saved.salt, saved.iterations);
		signal.throwIfAborted();
		return key;
	}
	private async replace(
		expected: SavedSession | null,
		next: SavedSession | undefined,
		signal: AbortSignal,
	) {
		await this.database.update<SavedSession>(
			"session",
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
	private async protectSession(
		expected: SavedSession | null,
		password: string,
		seal: Sealer,
		signal: AbortSignal,
		remember = false,
		registrationPending = false,
	) {
		if (password.length < 8) {
			throw new Error("Master password must be at least 8 characters.");
		}
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const key = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
		signal.throwIfAborted();
		const encrypted = await seal(key);
		signal.throwIfAborted();
		const saved: SavedSession = {
			revision: crypto.randomUUID(),
			salt,
			iterations: PBKDF2_ITERATIONS,
			encrypted,
			registrationPending,
			...(remember ? { key } : {}),
		};
		await this.replace(expected, saved, signal);
		return { saved, key };
	}
	private async saveSession(
		saved: SavedSession,
		encrypted: unknown,
		registrationPending: boolean,
		signal: AbortSignal,
	) {
		const next: SavedSession = {
			...saved,
			revision: crypto.randomUUID(),
			encrypted,
			registrationPending,
		};
		await this.replace(saved, next, signal);
		return next;
	}
	private async rememberKey(
		saved: SavedSession,
		key: CryptoKey | null,
		signal: AbortSignal,
	) {
		// Rewriting an unchanged session would invalidate other tabs' revisions.
		if (!key && !saved.key) {
			return saved;
		}
		const next: SavedSession = {
			revision: crypto.randomUUID(),
			salt: saved.salt,
			iterations: saved.iterations,
			encrypted: saved.encrypted,
			registrationPending: saved.registrationPending,
			...(key ? { key } : {}),
		};
		await this.replace(saved, next, signal);
		return next;
	}
	private async lockSession(signal: AbortSignal) {
		return (
			(await this.database.update<SavedSession>(
				"session",
				(saved) =>
					saved
						? {
								revision: crypto.randomUUID(),
								salt: saved.salt,
								iterations: saved.iterations,
								encrypted: saved.encrypted,
								registrationPending: saved.registrationPending,
							}
						: undefined,
				signal,
			)) ?? null
		);
	}
	private resetSession(signal: AbortSignal) {
		return this.database.update<SavedSession>(
			"session",
			() => undefined,
			signal,
		);
	}
	private disposeStorage() {
		this.database.dispose();
	}
}
