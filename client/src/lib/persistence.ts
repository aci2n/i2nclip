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

interface SavedIdentity {
	v: 1;
	iterations: number;
	salt: Uint8Array<ArrayBuffer>;
	encrypted: unknown;
}
const STORAGE_KEY = "i2nclip.identity";
const PURPOSE = "i2nclip/local-identity/1";
// One atomic storage record. The unwrapped key and identity exist only in memory.
export function createPersistence(
	storage?: LocalStorage,
	events: EventTarget | undefined = typeof window === "undefined"
		? undefined
		: window,
) {
	const local = () => storage ?? globalThis.localStorage;
	let unlocked: { record: SavedIdentity; key: CryptoKey } | null = null;
	let generation = 0;
	let observed: string | null = null;
	function unchanged(expected: string | null) {
		if (local().getItem(STORAGE_KEY) !== expected) {
			throw new Error(
				"Saved identity changed in another tab. Unlock this client again.",
			);
		}
	}
	function write(value: SavedIdentity, expected: string | null) {
		unchanged(expected);
		const text = bytesToB64(encode(value));
		local().setItem(STORAGE_KEY, text);
		observed = text;
	}
	function loadRecord(): SavedIdentity | null {
		const text = local().getItem(STORAGE_KEY);
		observed = text;
		if (!text) {
			return null;
		}
		const value = document(decode(b64ToBytes(text)));
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
			...value,
			v: 1,
			iterations: value.iterations,
			salt: binary(value.salt),
			encrypted: value.encrypted,
		};
	}
	async function save(identity: Identity | null) {
		const current = unlocked;
		if (!current) {
			throw new Error("Unlock this client first.");
		}
		const expected = observed;
		const own = generation;
		const encrypted = await sealBytes(current.key, encode(identity), PURPOSE);
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		const next = { ...current.record, encrypted };
		write(next, expected);
		unlocked = { ...current, record: next };
	}
	async function setPassword(password: string, identity: unknown) {
		const expected = observed;
		const own = generation;
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const nextKey = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
		const encrypted = await sealBytes(nextKey, encode(identity), PURPOSE);
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		const next: SavedIdentity = {
			v: 1,
			salt,
			iterations: PBKDF2_ITERATIONS,
			encrypted,
		};
		write(next, expected);
		unlocked = { record: next, key: nextKey };
	}
	async function unlock(password: string) {
		const saved = loadRecord();
		if (!saved) {
			throw new Error("Create a master password first.");
		}
		const expected = observed;
		const own = generation;
		const nextKey = await wrappingKey(password, saved.salt, PBKDF2_ITERATIONS);
		let identity: unknown;
		try {
			identity = decode(await openBytes(nextKey, saved.encrypted, PURPOSE));
		} catch {
			throw new Error("Wrong password or damaged saved identity.");
		}
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		unchanged(expected);
		unlocked = { record: saved, key: nextKey };
		return identity;
	}
	function lock() {
		generation++;
		unlocked = null;
	}
	return {
		onExternalChange(changed: () => void) {
			function storageChanged(event: Event) {
				if (
					!("key" in event) ||
					(event.key !== null && event.key !== STORAGE_KEY)
				) {
					return;
				}
				try {
					if ("storageArea" in event && event.storageArea !== local()) {
						return;
					}
					if (local().getItem(STORAGE_KEY) === observed) {
						return;
					}
				} catch {
					// The session locks and reports storage failures when it re-reads.
				}
				changed();
			}
			events?.addEventListener("storage", storageChanged);
			return () => events?.removeEventListener("storage", storageChanged);
		},
		read: () => loadRecord() !== null,
		async initialize(password: string) {
			if (local().getItem(STORAGE_KEY)) {
				throw new Error("A master password is already configured.");
			}
			if (password.length < 8) {
				throw new Error("Master password must be at least 8 characters.");
			}
			return setPassword(password, null);
		},
		unlock,
		save,
		async changePassword(current: string, password: string) {
			if (password.length < 8) {
				throw new Error("Master password must be at least 8 characters.");
			}
			return setPassword(password, await unlock(current));
		},
		lock,
		reset() {
			local().removeItem(STORAGE_KEY);
			observed = null;
			lock();
		},
	};
}
