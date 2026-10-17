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
	let record: SavedIdentity | null = null;
	let key: CryptoKey | null = null;
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
			record = null;
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
		record = {
			...value,
			v: 1,
			iterations: value.iterations,
			salt: binary(value.salt),
			encrypted: value.encrypted,
		};
		return record;
	}
	async function save(identity: Identity | null) {
		if (!key || !record) {
			throw new Error("Unlock this client first.");
		}
		const previous = record;
		const expected = observed;
		const own = generation;
		const encrypted = await sealBytes(key, encode(identity), PURPOSE);
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		const next = { ...previous, encrypted };
		write(next, expected);
		record = next;
	}
	async function initialize(password: string) {
		if (record || local().getItem(STORAGE_KEY)) {
			throw new Error("A master password is already configured.");
		}
		if (password.length < 8) {
			throw new Error("Master password must be at least 8 characters.");
		}
		const expected = observed;
		const own = generation;
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const nextKey = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
		const encrypted = await sealBytes(nextKey, encode(null), PURPOSE);
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		const next = {
			v: 1 as const,
			salt,
			iterations: PBKDF2_ITERATIONS,
			encrypted,
		};
		write(next, expected);
		record = next;
		key = nextKey;
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
		key = nextKey;
		return identity;
	}
	return {
		onExternalChange(changed: () => void) {
			function invalidate() {
				generation++;
				key = null;
				record = null;
				changed();
			}
			function check() {
				let current: string | null;
				try {
					current = local().getItem(STORAGE_KEY);
				} catch {
					invalidate();
					return;
				}
				if (current === observed) {
					return;
				}
				observed = current;
				invalidate();
			}
			function storageChanged(event: Event) {
				if ("storageArea" in event && event.storageArea !== local()) {
					return;
				}
				if (
					!("key" in event) ||
					(event.key !== null && event.key !== STORAGE_KEY)
				) {
					return;
				}
				check();
			}
			events?.addEventListener("storage", storageChanged);
			events?.addEventListener("pageshow", check);
			return () => {
				events?.removeEventListener("storage", storageChanged);
				events?.removeEventListener("pageshow", check);
			};
		},
		read: () => loadRecord() !== null,
		initialize,
		unlock,
		save,
		async changePassword(current: string, password: string) {
			if (password.length < 8) {
				throw new Error("Master password must be at least 8 characters.");
			}
			const identity = await unlock(current);
			const expected = observed;
			const own = generation;
			const salt = crypto.getRandomValues(new Uint8Array(16));
			const nextKey = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
			const encrypted = await sealBytes(nextKey, encode(identity), PURPOSE);
			if (own !== generation) {
				throw new DOMException("Client locked.", "AbortError");
			}
			const next = {
				v: 1 as const,
				salt,
				iterations: PBKDF2_ITERATIONS,
				encrypted,
			};
			write(next, expected);
			record = next;
			key = nextKey;
		},
		lock() {
			generation++;
			key = null;
		},
		reset() {
			unchanged(observed);
			local().removeItem(STORAGE_KEY);
			observed = null;
			generation++;
			record = null;
			key = null;
		},
	};
}
