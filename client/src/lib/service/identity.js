import { get, writable } from "svelte/store";
import { isKeyRegistered, registerKey } from "../api.js";
import { loadKey } from "../protocol/crypto.js";
import { generatePrivateKey } from "../protocol/identity.js";
import { parseRecoveryFile, recoveryFile } from "../protocol/recovery.js";
import { checkServer } from "../protocol/server.js";
import { unwrapPrivateKey, wrapPrivateKey } from "../protocol/vault.js";
import { createSessionContext } from "./identity-context.js";
import { errorDetails, traceEvent } from "./trace.js";

// Private to the owner. Pairing uses operation handles; pages never receive them.
export function createIdentity(
	repository,
	defaultServerUrl,
	serialize,
	authorizeRegistration,
) {
	let config = {};
	let privateKey = "";
	let epoch = 0;
	let tail = Promise.resolve();
	let controller = new AbortController();
	let disposed = false;
	let mutation = 0;
	const state = writable({
		ready: false,
		serverUrl: defaultServerUrl,
		privateKey: "",
		publicKey: "",
		wrappedKey: null,
		pendingRegistration: null,
		identityGeneration: null,
		epoch,
		busy: false,
		error: "",
	});
	const context = createSessionContext(state);
	function publish(extra = {}) {
		state.set({
			...get(state),
			...config,
			serverUrl:
				config.pendingRegistration?.serverUrl ||
				config.serverUrl ||
				defaultServerUrl,
			publicKey: config.publicKey || "",
			wrappedKey: config.wrappedKey || null,
			pendingRegistration: config.pendingRegistration || null,
			identityGeneration: config.identityGeneration || null,
			privateKey,
			epoch,
			...extra,
		});
	}
	const ready = repository.getConfig().then((value) => {
		config = value;
		publish({ ready: true });
	});
	function queue(action) {
		if (serialize) return serialize(action);
		const result = tail.then(action);
		tail = result.catch(() => {});
		return result;
	}
	function invalidate() {
		epoch++;
		controller.abort(
			new DOMException("Library changed. Try again.", "AbortError"),
		);
		controller = new AbortController();
		context.invalidate();
	}
	async function mutate(action, { reset = false } = {}) {
		if (disposed) throw new Error("Session ended.");
		if (get(state).busy && !reset)
			throw new Error("Session is busy. Try again.");
		const id = ++mutation;
		traceEvent("identity.mutation.start", { mutation: id, reset });
		invalidate();
		const signal = controller.signal;
		publish({ busy: true, error: "" });
		return queue(async () => {
			await ready;
			try {
				signal.throwIfAborted();
				const result = await action(signal);
				signal.throwIfAborted();
				publish({ error: "" });
				traceEvent("identity.mutation.completed", { mutation: id });
				return result ?? true;
			} catch (error) {
				traceEvent("identity.mutation.failed", {
					mutation: id,
					...errorDetails(error),
				});
				config = await repository.getConfig();
				if (id === mutation) publish({ error: error.message });
				throw error;
			} finally {
				if (id === mutation) publish({ busy: false });
			}
		});
	}
	async function save(serverUrl, key, wrappedKey, signal) {
		const loaded = await loadKey(key);
		signal.throwIfAborted();
		const next = {
			serverUrl,
			wrappedKey,
			publicKey: loaded.registrationKey,
			identityGeneration: crypto.randomUUID(),
			pendingRegistration: null,
		};
		await repository.setConfig(next);
		signal.throwIfAborted();
		config = next;
		privateKey = key;
	}
	const identity = {
		subscribe: state.subscribe,
		ready,
		get epoch() {
			return epoch;
		},
		get signal() {
			return controller.signal;
		},
		credentials() {
			if (disposed || !privateKey || get(state).busy)
				throw new Error("Unlock before uploading.");
			return {
				serverUrl: get(state).serverUrl,
				privateKey,
				publicKey: config.publicKey,
				identityGeneration: config.identityGeneration,
			};
		},
		operation: context.operation,
		async withIdentity(operation, action) {
			if (!context.owns(operation))
				throw new Error("Invalid session operation.");
			await ready;
			return queue(async () => {
				operation.signal.throwIfAborted();
				if (!context.matches(context.expected(operation), get(state)))
					throw new Error("Library changed. Start again.");
				return action(identity.credentials());
			});
		},
		create: ({ serverUrl, password, otc = "", authorizerLibraryId }) =>
			mutate(async (signal) => {
				checkServer(serverUrl);
				if (config.wrappedKey)
					throw new Error("A library is already configured.");
				if (password.length < 8)
					throw new Error("Password must be at least 8 characters.");
				if (!otc.trim() && !authorizerLibraryId)
					throw new Error("Enter an invitation code from the admin.");
				let pending = config.pendingRegistration;
				const retry = Boolean(pending);
				let key;
				if (pending) {
					if (pending.serverUrl !== serverUrl)
						throw new Error(
							"Retry creation on its original server, or discard the pending creation first.",
						);
					key = await unwrapPrivateKey(pending.wrappedKey, password);
					if ((await loadKey(key)).registrationKey !== pending.publicKey)
						throw new Error("Invalid pending identity.");
				} else {
					const created = await generatePrivateKey();
					key = created.privateKey;
					pending = {
						serverUrl,
						publicKey: created.publicKey,
						wrappedKey: await wrapPrivateKey(key, password),
						method: authorizerLibraryId ? "authorize" : "create",
						authorizerLibraryId: authorizerLibraryId || "",
					};
					signal.throwIfAborted();
					await repository.setConfig({
						...config,
						pendingRegistration: pending,
					});
					config = { ...config, pendingRegistration: pending };
					publish();
				}
				signal.throwIfAborted();
				try {
					if (
						!retry ||
						!(await isKeyRegistered({ serverUrl, privateKey: key, signal }))
					)
						if (authorizerLibraryId) {
							if (!authorizeRegistration)
								throw new Error("Authenticated registration is unavailable.");
							await authorizeRegistration(
								authorizerLibraryId,
								pending.publicKey,
								serverUrl,
								signal,
							);
						} else {
							await registerKey({
								serverUrl,
								publicKey: pending.publicKey,
								otc,
								signal,
							});
						}
				} catch (error) {
					signal.throwIfAborted();
					throw new Error(
						`Registration failed: ${error.message}. Your encrypted identity is saved. Check your registration method and retry with the original password.`,
					);
				}
				await save(serverUrl, key, pending.wrappedKey, signal);
			}),
		restore: (file, password) =>
			mutate(async (signal) => {
				if (config.wrappedKey)
					throw new Error("A library is already configured.");
				if (config.pendingRegistration)
					throw new Error(
						"Finish or discard the pending creation before restoring a library.",
					);
				if (!file || file.size > 16_384)
					throw new Error("Invalid recovery file.");
				const recovered = parseRecoveryFile(await file.text());
				await save(
					recovered.serverUrl,
					await unwrapPrivateKey(recovered.wrappedKey, password),
					recovered.wrappedKey,
					signal,
				);
			}),
		unlock: (password) =>
			mutate(async (signal) => {
				if (!config.wrappedKey)
					throw new Error("Create or restore your library in Settings.");
				const key = await unwrapPrivateKey(config.wrappedKey, password);
				if ((await loadKey(key)).registrationKey !== config.publicKey)
					throw new Error("Invalid saved identity.");
				signal.throwIfAborted();
				privateKey = key;
			}),
		setServer: (serverUrl) =>
			mutate(async (signal) => {
				checkServer(serverUrl);
				if (config.pendingRegistration)
					throw new Error(
						"Finish or discard the pending creation before changing servers.",
					);
				await repository.setConfig(
					{ ...config, serverUrl },
					{ clearUploads: true },
				);
				signal.throwIfAborted();
				config = { ...config, serverUrl };
			}),
		discardCreation: () =>
			mutate(async () => {
				config = { ...config, pendingRegistration: null };
				await repository.setConfig(config);
			}),
		reset: () =>
			mutate(
				async () => {
					await repository.reset();
					config = {};
					privateKey = "";
				},
				{ reset: true },
			),
		backup: async () => {
			await ready;
			return new Blob([recoveryFile(config)], { type: "application/json" });
		},
		importPairing: async ({
			serverUrl,
			privateKey: key,
			publicKey,
			password,
			signal,
			onInvalidated,
		}) => {
			await mutate(async (ownSignal) => {
				signal.throwIfAborted();
				checkServer(serverUrl);
				if (config.wrappedKey || config.pendingRegistration)
					throw new Error(
						"A library or pending creation is already configured.",
					);
				if (password.length < 8)
					throw new Error("Password must be at least 8 characters.");
				if ((await loadKey(key)).registrationKey !== publicKey)
					throw new Error("Invalid paired identity.");
				const wrappedKey = await wrapPrivateKey(key, password);
				signal.throwIfAborted();
				await save(
					serverUrl,
					key,
					wrappedKey,
					AbortSignal.any([ownSignal, signal]),
				);
			});
			return context.operation({ signal, onInvalidated });
		},
		dispose() {
			disposed = true;
			invalidate();
			privateKey = "";
		},
	};
	return identity;
}
