import { loadKey } from "../protocol/crypto.js";
import {
	exportRecovery,
	openRecovery,
	MAX_RECOVERY_BYTES,
} from "../protocol/recovery.js";
import { checkServer } from "../protocol/server.js";
import { createLibraryRuntime } from "./runtime.js";
import { serviceTracing, traceEvent, traceMessage } from "./trace.js";

const empty = (serverUrl) => ({
	session: {
		ready: false,
		configured: false,
		unlocked: false,
		serverUrl,
		epoch: 0,
		busy: false,
		error: "",
		pendingRegistration: null,
	},
	uploads: [],
	media: {},
	views: {},
	pairing: { active: false },
});

function uploadScheduler() {
	let busy = false,
		pending = [];
	function pump() {
		if (busy) return;
		pending.sort((a, b) => a.order - b.order);
		const next = pending.shift();
		if (!next) return;
		next.signal.removeEventListener("abort", next.abort);
		if (next.signal.aborted) {
			next.reject(next.signal.reason);
			pump();
			return;
		}
		busy = true;
		next.resolve(() => {
			busy = false;
			queueMicrotask(pump);
		});
	}
	return {
		acquire(order, signal) {
			return new Promise((resolve, reject) => {
				signal.throwIfAborted();
				const entry = {
					order,
					signal,
					resolve,
					reject,
					abort() {
						pending = pending.filter((item) => item !== entry);
						reject(signal.reason);
					},
				};
				pending.push(entry);
				signal.addEventListener("abort", entry.abort, { once: true });
				queueMicrotask(pump);
			});
		},
	};
}

export function createServiceEngine(options) {
	const { repository, defaultServerUrl } = options;
	const runtimes = new Map(),
		rows = new Map(),
		clients = new Map();
	const instanceId = crypto.randomUUID(),
		uploadLane = uploadScheduler();
	const configured = new Map();
	let catalogRevision = 0;
	let vaultEpoch = 0;
	let vault = {
		ready: false,
		status: "locked",
		busy: false,
		error: "",
		epoch: vaultEpoch,
	};
	const transientUploads = new Map();
	const unlocked = () => vault.status === "unlocked";
	function requireUnlocked() {
		if (!unlocked()) throw new Error("Unlock the client first.");
	}
	function vaultGuard(epoch) {
		if (epoch !== vaultEpoch || disposed)
			throw new Error("Vault context ended. Try again.");
	}

	async function notifyCatalog() {
		const revision = ++catalogRevision;
		const records = unlocked() ? await repository.libraries() : [];
		if (!disposed && revision === catalogRevision)
			options.platform?.onCatalog?.(
				records.filter((row) => row.identity?.privateKey).map(({id, name}) => ({id, name})),
			);
	}
	let disposed = false,
		order = 0,
		tail = Promise.resolve();
	const serialize = (action) => {
		const result = tail.then(action);
		tail = result.catch(() => {});
		return result;
	};
	function send(client, message) {
		if (!clients.has(client.id)) return;
		const outgoing = {
			...message,
			instanceId,
			clientId: client.id,
			sequence: ++client.sequence,
		};
		if (serviceTracing) traceMessage("owner → client", client.id, outgoing);
		try {
			client.deliver(outgoing);
		} catch {
			disconnect(client.id);
		}
	}
	function snapshot(client) {
		if (!unlocked())
			return {
				vault,
				catalog: [],
				setups: [],
				libraries: {},
				session: { ...empty("").session, ready: vault.ready },
			};
		const entries = [...rows.values()].map(({ id, name, setup }) => ({
			id,
			name,
			setup,
		}));
		return {
			vault,
			transientUploads: [...transientUploads].map(([id, entry]) => ({
				id,
				withTags: entry.withTags,
			})),
			catalog: entries.filter(
				(row) => client.states.get(row.id)?.session.configured,
			),
			setups: entries.filter(
				(row) => !client.states.get(row.id)?.session.configured,
			),
			libraries: Object.fromEntries(
				[...rows.keys()].map((id) => [
					id,
					client.states.get(id) || empty(defaultServerUrl),
				]),
			),
		};
	}
	function publish() {
		for (const client of clients.values()) {
			if (
				unlocked() &&
				[...rows.keys()].some((id) => !client.states.get(id)?.session.ready)
			)
				continue;
			send(client, { type: "snapshot", value: snapshot(client) });
		}
	}
	function attach(client, id, runtime) {
		const connection = runtime.connect((message) => {
			if (
				!clients.has(client.id) ||
				!rows.has(id) ||
				runtimes.get(id) !== runtime
			)
				return;
			if (message.type === "snapshot") {
				client.states.set(id, {
					...message.value,
					runtimeId: runtime.instanceId,
				});
				publish();
				return;
			}
			if (message.type === "state") {
				const state = client.states.get(id) || empty(defaultServerUrl);
				if (message.topic === "view")
					state.views = { ...state.views, [message.value.id]: message.value };
				else if (message.topic === "media")
					state.media = { ...state.media, [message.value.id]: message.value };
				else if (message.topic === "mediaReset") state.media = {};
				else state[message.topic] = message.value;
				client.states.set(id, state);
				if (!unlocked()) return;
				send(client, { type: "state", topic: "library", value: { id, state } });
				if (message.topic === "session") {
					if (configured.get(id) !== message.value.configured) {
						configured.set(id, message.value.configured);
						void notifyCatalog().catch(() => {});
					}
					publish();
				}
			} else if (unlocked()) send(client, { ...message, libraryId: id });
		});
		client.connections.set(id, connection);
	}
	function install(row) {
		traceEvent("library.install", { libraryId: row.id });
		if (disposed) throw new Error("Service ended.");
		rows.set(row.id, row);
		configured.set(row.id, Boolean(row.identity?.privateKey));
		const runtime = createLibraryRuntime({
			...options,
			repository: repository.scope(row.id),
			libraryId: row.id,
			platform: {
				...options.platform,
				openUpload: (id, page) =>
					options.platform?.openUpload?.(id, page, row.id),
			},
			uploadLane,
			nextJobOrder: () => ++order,
			authorizeRegistration: (id, publicKey, serverUrl, signal) => {
				const authorizer = runtimes.get(id);
				if (!authorizer)
					throw new Error("Choose an unlocked authorizing library.");
				return authorizer.authorizeKey(publicKey, serverUrl, signal);
			},
		});
		runtimes.set(row.id, runtime);
		for (const client of clients.values()) attach(client, row.id, runtime);
		return runtime;
	}
	function validateName(name, id) {
		name = String(name || "").trim();
		if (!name || name.length > 80)
			throw new Error("Use a library name from 1 to 80 characters.");
		if (
			[...rows.values()].some(
				(row) => row.id !== id && row.name.toLowerCase() === name.toLowerCase(),
			)
		)
			throw new Error("That library name is already used.");
		return name;
	}
	async function add(name, serverUrl = defaultServerUrl, setup) {
		checkServer(serverUrl);
		const row = {
			id: crypto.randomUUID(),
			name: validateName(name),
			identity: { serverUrl },
			setup,
		};
		await repository.putLibrary(row);
		const runtime = install(row);
		await runtime.ready;
		await notifyCatalog();
		publish();
		return row.id;
	}
	async function activate() {
		const captured = vaultEpoch;
		const stored = await repository.libraries();
		const jobs = await repository.jobs();
		vaultGuard(captured);
		// Validate every identity before exposing any library to pages.
		for (const row of stored) {
			for (const value of [row.identity, row.identity?.pendingRegistration]) {
				if (
					value?.privateKey &&
					(await loadKey(value.privateKey)).registrationKey !== value.publicKey
				)
					throw new Error("Invalid saved identity.");
				vaultGuard(captured);
			}
		}
		order = Math.max(0, ...jobs.map((job) => job.order || 0));
		for (const row of stored) install(row);
		if (!stored.length) await add("Personal");
		await Promise.all([...runtimes.values()].map((runtime) => runtime.ready));
	}
	function clearRuntimes() {
		for (const runtime of runtimes.values()) runtime.dispose();
		runtimes.clear();
		rows.clear();
		configured.clear();
		for (const client of clients.values()) {
			for (const connection of client.connections.values())
				connection.disconnect();
			client.connections.clear();
			client.states.clear();
		}
	}
	function lockVault() {
		vaultEpoch++;
		vault = {
			...vault,
			status: repository.initialized ? "locked" : "uninitialized",
			busy: false,
			error: "",
			epoch: vaultEpoch,
		};
		clearRuntimes();
		repository.lock();
		publish();
		void notifyCatalog().catch(() => {});
	}
	const ready = (async () => {
		await repository.ready;
		vault = {
			...vault,
			ready: true,
			status: repository.initialized ? "locked" : "uninitialized",
		};
		if (repository.unlocked) {
			vault.status = "unlocked";
			await activate();
		}
		await notifyCatalog();
	})();
	async function vaultCommand(name, payload) {
		const epoch = vaultEpoch;
		if (name === "vault.initialize" || name === "vault.unlock") {
			if (unlocked()) return true;
			vault = { ...vault, busy: true, error: "" };
			publish();
			try {
				await repository[name.slice(6)](payload.password);
				vaultGuard(epoch);
				// Keep snapshots hidden until activation completes.
				await activate();
				vaultGuard(epoch);
				vault = { ...vault, status: "unlocked", busy: false };
				await notifyCatalog();
				publish();
				return true;
			} catch (error) {
                clearRuntimes(); repository.lock();
				if (epoch === vaultEpoch) {
					vault = {
						...vault,
						status: repository.initialized ? "locked" : "uninitialized",
						busy: false,
						error: error.message,
					};
					publish();
				}
				throw error;
			}
		}
		if (name === "vault.reset") {
			await repository.resetVault();
			vaultGuard(epoch);
			transientUploads.clear();
			vault = { ...vault, status: "uninitialized", busy: false, error: "" };
			publish();
			return true;
		}
		requireUnlocked();
		if (name === "vault.changePassword") {
			await repository.changePassword(
				payload.currentPassword,
				payload.password,
			);
			vaultGuard(epoch);
			return true;
		}
		if (name === "vault.export") {
			const records = (await repository.libraries()).filter(
				(row) =>
					row.identity?.privateKey &&
					(!payload.libraryId || row.id === payload.libraryId),
			);
			const text = await exportRecovery(
				records.map((row) => ({
					name: row.name,
					serverUrl: row.identity.serverUrl,
					privateKey: row.identity.privateKey,
				})),
				payload.password,
				payload.libraryId ? "library" : "vault",
			);
			vaultGuard(epoch);
			return new Blob([text], { type: "application/json" });
		}
		if (name === "vault.previewRecovery" || name === "vault.importRecovery") {
			if (!payload.file || payload.file.size > MAX_RECOVERY_BYTES)
				throw new Error("Invalid recovery file.");
			const manifest = await openRecovery(
				await payload.file.text(),
				payload.password,
			);
			vaultGuard(epoch);
			if (name === "vault.previewRecovery")
				return manifest.libraries.map(({ name, serverUrl }) => ({
					name,
					serverUrl,
				}));
			const existing = await repository.libraries();
			const records = [];
			for (const row of manifest.libraries) {
				const publicKey = (await loadKey(row.privateKey)).registrationKey;
				if (
					existing.some(
						(item) =>
							item.identity?.publicKey === publicKey &&
							new URL(item.identity.serverUrl).origin ===
								new URL(row.serverUrl).origin,
					)
				)
					continue;
				let name = row.name.trim(),
					suffix = 2;
				while (
					[...existing, ...records].some(
						(item) => item.name.toLowerCase() === name.toLowerCase(),
					)
				)
					name = `${row.name.trim().slice(0, 70)} (${suffix++})`;
				records.push({
					id: crypto.randomUUID(),
					name,
					identity: {
						serverUrl: row.serverUrl,
						publicKey,
						privateKey: row.privateKey,
						identityGeneration: crypto.randomUUID(),
						pendingRegistration: null,
					},
				});
			}
			vaultGuard(epoch);
			await repository.importLibraries(records);
			vaultGuard(epoch);
			for (const row of records) await install(row).ready;
			await notifyCatalog();
			publish();
			return {
				imported: records.map((row) => row.id),
				skipped: manifest.libraries.length - records.length,
			};
		}
		if (name === "vault.contextUpload") {
			const entry = transientUploads.get(payload.id);
			if (!entry)
				throw new Error(
					"Upload request expired. Invoke the context menu again.",
				);
			const runtime = runtimes.get(payload.libraryId);
			if (!runtime || !getConfigured(payload.libraryId))
				throw new Error("Choose a destination library.");
			const result = await runtime.contextUpload(
				{ ...entry.source, id: payload.id },
				entry.withTags,
				false,
			);
			vaultGuard(epoch);
			transientUploads.delete(payload.id);
			publish();
			return result;
		}
		throw new Error("Unknown vault command.");
	}
	function getConfigured(id) {
		return Boolean(rows.get(id)?.identity?.privateKey) || configured.get(id);
	}

	function disconnect(id) {
		traceEvent("client.disconnect", { clientId: id });
		const client = clients.get(id);
		if (!client) return;
		clients.delete(id);
		for (const connection of client.connections.values())
			connection.disconnect();
	}
	async function catalogCommand(name, payload) {
		const onlySetups = name === "libraries.discardSetup";
		if (name === "libraries.add" || name === "libraries.beginSetup") {
			if (
				name === "libraries.beginSetup" &&
				!["create", "authorize", "pair", "restore"].includes(payload.method)
			)
				throw new Error("Choose a setup method.");
			return add(payload.name, payload.serverUrl, {
				method: payload.method || "create",
				authorizerLibraryId: payload.authorizerLibraryId || "",
			});
		}
		if (name === "libraries.rename") {
			const row = (await repository.libraries()).find(
				(row) => row.id === payload.libraryId,
			);
			if (!row) throw new Error("Library is no longer saved.");
			row.name = validateName(payload.name, row.id);
			await repository.renameLibrary(row.id, row.name);
			rows.set(row.id, row);
			await notifyCatalog();
			publish();
			return true;
		}
		if (name === "libraries.discardSetup") {
			const config = await repository.scope(payload.libraryId).getConfig();
			if (config.privateKey)
				throw new Error(
					"Setup completed. Keep the saved library and its recovery file.",
				);
			name = "libraries.forget";
		}
		if (name === "libraries.forget" || name === "libraries.reset") {
			const ids =
				name === "libraries.reset" ? [...rows.keys()] : [payload.libraryId];
			const saved = (await repository.libraries()).filter((row) =>
				ids.includes(row.id),
			);
			if (saved.length !== ids.length)
				throw new Error("Library is no longer saved.");
			const replacement =
				ids.length === rows.size
					? {
							id: crypto.randomUUID(),
							name: "Personal",
							identity: { serverUrl: defaultServerUrl },
						}
					: null;
			for (const id of ids) {
				runtimes.get(id).dispose();
				runtimes.delete(id);
				rows.delete(id);
				for (const client of clients.values()) {
					client.connections.get(id)?.disconnect();
					client.connections.delete(id);
					client.states.delete(id);
				}
			}
			try {
				await repository.deleteLibraries(ids, replacement, onlySetups);
			} catch (error) {
				for (const row of saved) install(row);
				await Promise.all(saved.map((row) => runtimes.get(row.id).ready));
				publish();
				throw error;
			}
			if (replacement) await install(replacement).ready;

			await notifyCatalog();
			publish();
			return true;
		}
		throw new Error("Unknown catalog command.");
	}
	return {
		ready,
		instanceId,
		async catalog() {
			await ready;
			if (!unlocked()) return [];
			return (await repository.libraries())
				.filter((row) => row.identity?.privateKey)
				.map(({ id, name }) => ({ id, name }));
		},
		async contextUpload(source, withTags, libraryId) {
			await ready;
			if (!unlocked()) {
				const id = crypto.randomUUID();
				transientUploads.set(id, { source, withTags });
				await options.platform?.openUpload?.(
					id,
					withTags ? "upload" : "unlock",
					"",
				);
				return id;
			}
			if (!libraryId) {
				const registered = (await repository.libraries()).filter(
					(row) => row.identity?.privateKey,
				);
				if (registered.length !== 1)
					throw new Error("Choose a destination library.");
				libraryId = registered[0].id;
			}
			const runtime = runtimes.get(libraryId);
			if (!runtime) throw new Error("Library is no longer saved.");
			return runtime.contextUpload(source, withTags);
		},
		connect(deliver) {
			traceEvent("client.connect", { connectedClients: clients.size + 1 });
			const client = {
				id: crypto.randomUUID(),
				deliver,
				sequence: 0,
				connections: new Map(),
				states: new Map(),
			};
			clients.set(client.id, client);
			ready
				.then(() => {
					if (!clients.has(client.id)) return;
					for (const [id, runtime] of runtimes)
						if (!client.connections.has(id)) attach(client, id, runtime);
					publish();
				})
				.catch((error) =>
					send(client, { type: "fatal", error: error.message }),
				);
			return {
				id: client.id,
				disconnect: () => disconnect(client.id),
				async receive(message) {
					await ready;
					if (!clients.has(client.id)) return;
					if (serviceTracing)
						traceMessage("client → owner", client.id, message);
					if (message.type === "detach") {
						disconnect(client.id);
						return;
					}
					if (message.type === "ping") {
						send(client, { type: "pong" });
						return;
					}
					if (message.type === "command" && message.instanceId !== instanceId)
						return;
					try {
						if (message.name === "snapshot") {
							publish();
							send(client, {
								type: "reply",
								requestId: message.requestId,
								value: true,
							});
							return;
						}
						if (message.name === "vault.lock" || message.name === "vault.reset")
							lockVault();
						if (message.name?.startsWith("vault.")) {
							if (
								message.name !== "vault.lock" &&
								message.name !== "vault.reset" &&
								message.payload?.vaultEpoch !== undefined &&
								message.payload.vaultEpoch !== vaultEpoch
							)
								throw new Error("Vault context ended. Try again.");
							const value =
								message.name === "vault.lock"
									? true
									: await serialize(() =>
											vaultCommand(message.name, message.payload || {}),
										);
							send(client, {
								type: "reply",
								requestId: message.requestId,
								value,
							});
							return;
						}
						requireUnlocked();
                        const commandEpoch = vaultEpoch;
                        if (message.payload?.vaultEpoch !== undefined) vaultGuard(message.payload.vaultEpoch);
						if (message.name?.startsWith("libraries.")) {
							const value = await serialize(async () => {vaultGuard(commandEpoch); requireUnlocked(); const result = await catalogCommand(message.name, message.payload || {}); vaultGuard(commandEpoch); return result;});
							send(client, {
								type: "reply",
								requestId: message.requestId,
								value,
							});
							return;
						}
						const id = message.libraryId || message.payload?.libraryId;
						const runtime = runtimes.get(id),
							connection = client.connections.get(id);
						if (!runtime || !connection)
							throw new Error("Choose a saved library.");
						if (
							message.payload?.runtimeId &&
							message.payload.runtimeId !== runtime.instanceId
						)
							throw new Error(
								"Library context ended. Check its state before retrying.",
							);
						await connection.receive({
							...message,
							instanceId: runtime.instanceId,
						});
					} catch (error) {
						publish();
						send(client, {
							type: "reply",
							requestId: message.requestId,
							error: { name: error.name, message: error.message },
						});
					}
				},
			};
		},
		dispose() {
			disposed = true;
			for (const runtime of runtimes.values()) runtime.dispose();
			for (const id of [...clients.keys()]) disconnect(id);
			repository.close();
		},
	};
}
