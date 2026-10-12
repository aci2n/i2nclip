import { get, writable } from "svelte/store";
import { isKeyRegistered, registerKey } from "../api.js";
import { loadKey } from "../protocol/crypto.js";
import { generatePrivateKey } from "../protocol/identity.js";
import { checkServer } from "../protocol/server.js";
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
		configured: false,
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
			configured: Boolean(config.privateKey),
			pendingRegistration: config.pendingRegistration || null,
			identityGeneration: config.identityGeneration || null,
			privateKey,
			epoch,
			...extra,
		});
	}
	const ready = repository.getConfig().then((value) => {
		config = value;
		privateKey = config.privateKey || "";
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
				if (!disposed) config = await repository.getConfig();
				if (id === mutation) publish({ error: error.message });
				throw error;
			} finally {
				if (id === mutation) publish({ busy: false });
			}
		});
	}
	async function save(serverUrl, key, signal) {
		const loaded = await loadKey(key);
		signal.throwIfAborted();
		const next = {
			serverUrl,
			privateKey: key,
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
		create: ({ serverUrl, otc = "", authorizerLibraryId }) =>
			mutate(async (signal) => {
				checkServer(serverUrl);
				if (config.privateKey)
					throw new Error("A library is already configured.");
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
					key = pending.privateKey;
					if ((await loadKey(key)).registrationKey !== pending.publicKey)
						throw new Error("Invalid pending identity.");
				} else {
					const created = await generatePrivateKey();
					key = created.privateKey;
					pending = {
						serverUrl,
						publicKey: created.publicKey,
						privateKey: key,
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
						`Registration failed: ${error.message}. Your encrypted identity is saved. Check your registration method and retry registration.`,
					);
				}
				await save(serverUrl, key, signal);
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
				privateKey = config.privateKey || "";
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
		importPairing: async ({
			serverUrl,
			privateKey: key,
			publicKey,
			signal,
			onInvalidated,
		}) => {
			await mutate(async (ownSignal) => {
				signal.throwIfAborted();
				checkServer(serverUrl);
				if (config.privateKey || config.pendingRegistration)
					throw new Error(
						"A library or pending creation is already configured.",
					);
				if ((await loadKey(key)).registrationKey !== publicKey)
					throw new Error("Invalid paired identity.");
				signal.throwIfAborted();
				await save(serverUrl, key, AbortSignal.any([ownSignal, signal]));
			});
			return context.operation({ signal, onInvalidated });
		},
		dispose() {
			disposed = true;
			invalidate();
			privateKey = "";
			config = {};
			publish({ ready: false, busy: false, error: "" });
		},
	};
	return identity;
}
