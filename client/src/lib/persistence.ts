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
import { requireValue } from "./required.ts";
export type LocalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_KEY = "i2nclip.identity";
const PURPOSE = "i2nclip/local-identity/1";
// One atomic storage record. The unwrapped key and identity exist only in memory.
export function createPersistence(storage?: LocalStorage) {
	const local = () => storage ?? globalThis.localStorage;
	let record: Record<string, unknown> | undefined;
	let key: CryptoKey | null = null;
	let generation = 0;
	function read() {
		const text = local().getItem(STORAGE_KEY);
		if (!text) {
			return false;
		}
		record = document(decode(b64ToBytes(text)));
		if (
			record.v !== 1 ||
			record.iterations !== PBKDF2_ITERATIONS ||
			!(record.salt instanceof Uint8Array) ||
			record.salt.length !== 16
		) {
			throw new Error(
				"Invalid saved identity. Reset this client or restore a recovery file.",
			);
		}
		return true;
	}
	async function save(identity: Identity | null) {
		if (!key) {
			throw new Error("Unlock this client first.");
		}
		const own = generation;
		const encrypted = await sealBytes(key, encode(identity), PURPOSE);
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		const next = { ...record, encrypted };
		local().setItem(STORAGE_KEY, bytesToB64(encode(next)));
		record = next;
	}
	async function initialize(password: string) {
		if (record || local().getItem(STORAGE_KEY)) {
			throw new Error("A master password is already configured.");
		}
		if (password.length < 8) {
			throw new Error("Master password must be at least 8 characters.");
		}
		const own = generation;
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const nextKey = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
		const encrypted = await sealBytes(nextKey, encode(null), PURPOSE);
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		const next = {
			v: 1,
			salt,
			iterations: PBKDF2_ITERATIONS,
			encrypted,
		};
		local().setItem(STORAGE_KEY, bytesToB64(encode(next)));
		record = next;
		key = nextKey;
	}
	async function unlock(password: string) {
		if (!read()) {
			throw new Error("Create a master password first.");
		}
		const own = generation;
		const nextKey = await wrappingKey(
			password,
			binary(requireValue(record).salt),
			PBKDF2_ITERATIONS,
		);
		let identity: unknown;
		try {
			identity = decode(
				await openBytes(nextKey, requireValue(record).encrypted, PURPOSE),
			);
		} catch {
			throw new Error("Wrong password or damaged saved identity.");
		}
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		key = nextKey;
		return identity;
	}
	return {
		read,
		initialize,
		unlock,
		save,
		async changePassword(current: string, password: string) {
			if (password.length < 8) {
				throw new Error("Master password must be at least 8 characters.");
			}
			const identity = await unlock(current);
			const own = generation;
			const salt = crypto.getRandomValues(new Uint8Array(16));
			const nextKey = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
			const encrypted = await sealBytes(nextKey, encode(identity), PURPOSE);
			if (own !== generation) {
				throw new DOMException("Client locked.", "AbortError");
			}
			const next = {
				v: 1,
				salt,
				iterations: PBKDF2_ITERATIONS,
				encrypted,
			};
			local().setItem(STORAGE_KEY, bytesToB64(encode(next)));
			record = next;
			key = nextKey;
		},
		lock() {
			generation++;
			key = null;
		},
		reset() {
			local().removeItem(STORAGE_KEY);
			generation++;
			record = undefined;
			key = null;
		},
	};
}
