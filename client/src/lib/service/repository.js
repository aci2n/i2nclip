import { utf8 } from "../protocol/bytes.js";
import {
	importVaultKey,
	openBytes,
	passwordOpen,
	passwordSeal,
	sealBytes,
} from "../protocol/vault.js";
import { decodeSource, encodeSource } from "./source-record.js";

// Only the owner opens IDB. Crypto finishes before a short atomic transaction.
export function createRepository(indexedDB = globalThis.indexedDB) {
	let database;
	const ready = new Promise((resolve, reject) => {
		if (!indexedDB) return reject(new Error("Local database is unavailable."));
		const request = indexedDB.open("i2nclip-vault", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("vault");
		request.onerror = () => reject(request.error);
		request.onblocked = () =>
			reject(
				new Error(
					"Local database is blocked. Close other app pages and retry.",
				),
			);
		request.onsuccess = () => {
			database = request.result;
			database.onversionchange = () => database.close();
			resolve();
		};
	});
	const active = new Set();
	const storage = {
		ready,
		async get(id) {
			await ready;
			return new Promise((resolve, reject) => {
				const tx = database.transaction("vault", "readonly");
				const request = tx.objectStore("vault").get(id);
				tx.oncomplete = () => resolve(request.result);
				tx.onabort = () =>
					reject(tx.error || new Error("Local database read failed."));
			});
		},
		async commit(entries, remove = [], clear = false) {
			await ready;
			return new Promise((resolve, reject) => {
				const tx = database.transaction("vault", "readwrite");
				active.add(tx);
				tx.oncomplete = () => {
					active.delete(tx);
					resolve();
				};
				tx.onabort = () => {
					active.delete(tx);
					reject(tx.error || new Error("Local database write canceled."));
				};
				const store = tx.objectStore("vault");
				if (clear) store.clear();
				for (const id of remove) store.delete(id);
				for (const [id, value] of entries) store.put(value, id);
			});
		},
		abort() {
			for (const tx of active) tx.abort();
		},
		close() {
			database?.close();
		},
	};
	return createEncryptedRepository(storage);
}

// Also used with an in-memory ciphertext backend by owner tests.
export function createEncryptedRepository(storage) {
	let key,
		header,
		data,
		epoch = 0,
		tail = Promise.resolve();
	const ready = Promise.resolve(storage.ready).then(async () => {
		header = await storage.get("header");
	});
	const empty = () => ({ libraries: [], jobs: [] });
	const guard = (captured) => {
		if (captured !== epoch)
			throw new Error("Vault context ended. Unlock and try again.");
	};
	const requireKey = () => {
		if (!key || !data) throw new Error("Unlock the client first.");
	};
	const aad = (part) => `i2nclip/local-vault/1/${header.id}/${part}`;
	const queue = (action) => {
		const captured = epoch;
		const result = tail.then(() => {
			guard(captured);
			return action(captured);
		});
		tail = result.catch(() => {});
		return result;
	};
	async function write(action) {
		return queue(async (captured) => {
			requireKey();
			const next = structuredClone(data);
			const changes = await action(next);
			guard(captured);
			const sealed = await sealBytes(
				key,
				utf8(JSON.stringify(next)),
				aad("catalog"),
				{ binary: true },
			);
			guard(captured);
			await storage.commit(
				[["catalog", sealed], ...(changes?.entries || [])],
				changes?.remove || [],
			);
			guard(captured);
			data = next;
		});
	}
	const rows = () => {
		requireKey();
		return structuredClone(data.libraries);
	};
	const clearJobs = (next, ids) => {
		const removed = next.jobs
			.filter((job) => ids.includes(job.libraryId))
			.map((job) => `source:${job.id}`);
		next.jobs = next.jobs.filter((job) => !ids.includes(job.libraryId));
		return removed;
	};
	function validateIdentity(next, libraryId, identity) {
		if (
			identity.publicKey &&
			next.libraries.some(
				(row) =>
					row.id !== libraryId &&
					row.identity?.publicKey === identity.publicKey &&
					new URL(row.identity.serverUrl).origin ===
						new URL(identity.serverUrl).origin,
			)
		)
			throw new Error(
				"This library is already saved. Select its existing entry.",
			);
	}
	const scope = (libraryId) => ({
		async getConfig() {
			return rows().find((row) => row.id === libraryId)?.identity || {};
		},
		setConfig(identity, { clearUploads = false } = {}) {
			return write((next) => {
				const row = next.libraries.find((row) => row.id === libraryId);
				if (!row) throw new Error("Library is no longer saved.");
				validateIdentity(next, libraryId, identity);
				row.identity = identity;
				return { remove: clearUploads ? clearJobs(next, [libraryId]) : [] };
			});
		},
		async jobs() {
			requireKey();
			return structuredClone(
				data.jobs.filter((job) => job.libraryId === libraryId),
			);
		},
		getSource(id) {
			return queue(async (captured) => {
				requireKey();
				if (
					!data.jobs.some((job) => job.id === id && job.libraryId === libraryId)
				)
					return undefined;
				const sealed = await storage.get(`source:${id}`);
				if (!sealed) return undefined;
				const bytes = await openBytes(key, sealed, aad(`source:${id}`));
				guard(captured);
				return decodeSource(bytes);
			});
		},
		putJob(job, source) {
			return write(async (next) => {
				next.jobs = next.jobs.filter((item) => item.id !== job.id);
				next.jobs.push({ ...job, libraryId });
				if (source === undefined) return;
				const bytes = await encodeSource(source);
				return {
					entries: [
						[
							`source:${job.id}`,
							await sealBytes(key, bytes, aad(`source:${job.id}`), {
								binary: true,
							}),
						],
					],
				};
			});
		},
		finishJob(job) {
			return write((next) => {
				next.jobs = next.jobs.filter((item) => item.id !== job.id);
				next.jobs.push({ ...job, libraryId });
				return { remove: [`source:${job.id}`] };
			});
		},
		removeJob(id) {
			return write((next) => {
				if (
					!next.jobs.some((job) => job.id === id && job.libraryId === libraryId)
				)
					return;
				next.jobs = next.jobs.filter((job) => job.id !== id);
				return { remove: [`source:${id}`] };
			});
		},
		reset: () => scope(libraryId).setConfig({}, { clearUploads: true }),
		close() {},
	});
	return {
		ready,
		get initialized() {
			return Boolean(header);
		},
		get unlocked() {
			return Boolean(key);
		},
		async initialize(password) {
			await ready;
			return queue(async (captured) => {
				if (header) throw new Error("A master password is already configured.");
				if (password.length < 8)
					throw new Error("Password must be at least 8 characters.");
				const bytes = crypto.getRandomValues(new Uint8Array(32));
				const id = crypto.randomUUID();
				const nextHeader = {
					v: 1,
					id,
					wrappedKey: await passwordSeal(
						bytes,
						password,
						`i2nclip/vault-key/1/${id}`,
					),
				};
				const nextKey = await importVaultKey(bytes);
				bytes.fill(0);
				const next = empty();
				const sealed = await sealBytes(
					nextKey,
					utf8(JSON.stringify(next)),
					`i2nclip/local-vault/1/${id}/catalog`,
					{ binary: true },
				);
				guard(captured);
				await storage.commit([
					["header", nextHeader],
					["catalog", sealed],
				]);
				header = nextHeader;
				guard(captured);
				key = nextKey;
				data = next;
			});
		},
		async unlock(password) {
			await ready;
			return queue(async (captured) => {
				if (!header) throw new Error("Create a master password first.");
				const bytes = await passwordOpen(
					header.wrappedKey,
					password,
					`i2nclip/vault-key/1/${header.id}`,
				);
				const nextKey = await importVaultKey(bytes);
				bytes.fill(0);
				const sealed = await storage.get("catalog");
				const next = JSON.parse(
					new TextDecoder().decode(
						await openBytes(nextKey, sealed, aad("catalog")),
					),
				);
				if (!Array.isArray(next.libraries) || !Array.isArray(next.jobs))
					throw new Error("Invalid saved vault.");
				guard(captured);
				key = nextKey;
				data = next;
			});
		},
		lock() {
			epoch++;
			key = undefined;
			data = undefined;
			storage.abort?.();
		},
		changePassword(currentPassword, password) {
			return queue(async (captured) => {
				requireKey();
				if (password.length < 8)
					throw new Error("Password must be at least 8 characters.");
				const bytes = await passwordOpen(
					header.wrappedKey,
					currentPassword,
					`i2nclip/vault-key/1/${header.id}`,
				);
				let wrappedKey;
				try {
					wrappedKey = await passwordSeal(
						bytes,
						password,
						`i2nclip/vault-key/1/${header.id}`,
					);
				} finally {
					bytes.fill(0);
				}
				guard(captured);
				const next = { ...header, wrappedKey };
				await storage.commit([["header", next]]);
				header = next;
				guard(captured);
			});
		},
		async resetVault() {
			this.lock();
			await ready;
			await tail;
			await storage.commit([], [], true);
			header = undefined;
		},
		async libraries() {
			return rows();
		},
		async jobs() {
			requireKey();
			return structuredClone(data.jobs);
		},
		putLibrary(row) {
			return write((next) => {
				validateIdentity(next, row.id, row.identity || {});
				next.libraries = next.libraries.filter((item) => item.id !== row.id);
				next.libraries.push(row);
			});
		},
		importLibraries(records, discardIds = []) {
			return write((next) => {
				next.libraries = next.libraries.filter(
					(row) => !discardIds.includes(row.id),
				);
				for (const row of records) {
					validateIdentity(next, row.id, row.identity);
					next.libraries.push(row);
				}
				return { remove: clearJobs(next, discardIds) };
			});
		},
		renameLibrary(id, name) {
			return write((next) => {
				const row = next.libraries.find((row) => row.id === id);
				if (!row) throw new Error("Library is no longer saved.");
				row.name = name;
			});
		},
		deleteLibraries(ids, replacement, onlySetups = false) {
			return write((next) => {
				if (
					onlySetups &&
					next.libraries.some(
						(row) => ids.includes(row.id) && row.identity?.privateKey,
					)
				)
					throw new Error(
						"Setup completed. Keep the saved library and its recovery file.",
					);
				next.libraries = next.libraries.filter((row) => !ids.includes(row.id));
				if (replacement) next.libraries.push(replacement);
				return { remove: clearJobs(next, ids) };
			});
		},
		scope,
		close() {
			this.lock();
			storage.close?.();
		},
	};
}
