import { b64ToBytes, bytesToB64, utf8 } from "./protocol/bytes.js";
import {
	openBytes,
	PBKDF2_ITERATIONS,
	sealBytes,
	wrappingKey,
} from "./protocol/vault.js";

const STORAGE_KEY = "i2nclip.identity";
const PURPOSE = "i2nclip/local-identity/1";

// One atomic storage record. The unwrapped key and identity exist only in memory.
export function createPersistence(storage = globalThis.localStorage) {
	let record;
	let key;
	let generation = 0;
	function read() {
		const text = storage.getItem(STORAGE_KEY);
		if (!text) {
			return false;
		}
		record = JSON.parse(text);
		if (
			record.v !== 1 ||
			record.iterations !== PBKDF2_ITERATIONS ||
			typeof record.salt !== "string" ||
			b64ToBytes(record.salt).length !== 16
		) {
			throw new Error(
				"Invalid saved identity. Reset this client or restore a recovery file.",
			);
		}
		return true;
	}
	async function save(identity) {
		if (!key) {
			throw new Error("Unlock this client first.");
		}
		const own = generation;
		const encrypted = await sealBytes(
			key,
			utf8(JSON.stringify(identity)),
			PURPOSE,
		);
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		const next = { ...record, encrypted };
		storage.setItem(STORAGE_KEY, JSON.stringify(next));
		record = next;
	}
	async function initialize(password) {
		if (record || storage.getItem(STORAGE_KEY)) {
			throw new Error("A master password is already configured.");
		}
		if (password.length < 8) {
			throw new Error("Master password must be at least 8 characters.");
		}
		const own = generation;
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const nextKey = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
		const encrypted = await sealBytes(nextKey, utf8("null"), PURPOSE);
		if (own !== generation) {
			throw new DOMException("Client locked.", "AbortError");
		}
		const next = {
			v: 1,
			salt: bytesToB64(salt),
			iterations: PBKDF2_ITERATIONS,
			encrypted,
		};
		storage.setItem(STORAGE_KEY, JSON.stringify(next));
		record = next;
		key = nextKey;
	}
	async function unlock(password) {
		if (!read()) {
			throw new Error("Create a master password first.");
		}
		const own = generation;
		const nextKey = await wrappingKey(
			password,
			b64ToBytes(record.salt),
			record.iterations,
		);
		let identity;
		try {
			identity = JSON.parse(
				new TextDecoder().decode(
					await openBytes(nextKey, record.encrypted, PURPOSE),
				),
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
		async changePassword(current, password) {
			if (password.length < 8) {
				throw new Error("Master password must be at least 8 characters.");
			}
			const identity = await unlock(current);
			const own = generation;
			const salt = crypto.getRandomValues(new Uint8Array(16));
			const nextKey = await wrappingKey(password, salt, PBKDF2_ITERATIONS);
			const encrypted = await sealBytes(
				nextKey,
				utf8(JSON.stringify(identity)),
				PURPOSE,
			);
			if (own !== generation) {
				throw new DOMException("Client locked.", "AbortError");
			}
			const next = {
				v: 1,
				salt: bytesToB64(salt),
				iterations: PBKDF2_ITERATIONS,
				encrypted,
			};
			storage.setItem(STORAGE_KEY, JSON.stringify(next));
			record = next;
			key = nextKey;
		},
		lock() {
			generation++;
			key = null;
		},
		reset() {
			storage.removeItem(STORAGE_KEY);
			generation++;
			record = null;
			key = null;
		},
	};
}
