import { get, writable } from "svelte/store";
import { registerKey } from "../api.js";
import { loadKey } from "../protocol/crypto.js";
import { generatePrivateKey } from "../protocol/identity.js";
import { checkServer } from "../protocol/server.js";
import { createSessionContext } from "./identity-context.js";
import { ExistingLibraryError } from "./repository.js";
import { errorDetails, traceEvent } from "./trace.js";

// Private to the owner. Pairing uses operation handles; pages never receive them.
export function createIdentity(
	repository,
	defaultServerUrl,
	serialize,
	authorizeRegistration,
	resolvePairing,
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
			serverUrl: config.serverUrl || defaultServerUrl,
			publicKey: config.publicKey || "",
			configured: Boolean(config.privateKey),
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
		if (serialize) {
			return serialize(action);
		}
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
		if (disposed) {
			throw new Error("Session ended.");
		}
		if (get(state).busy && !reset) {
			throw new Error("Session is busy. Try again.");
		}
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
				if (!disposed) {
					config = await repository.getConfig();
				}
				if (id === mutation) {
					publish({ error: error.message });
				}
				throw error;
			} finally {
				if (id === mutation) {
					publish({ busy: false });
				}
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
			if (disposed || !privateKey || get(state).busy) {
				throw new Error("Unlock before uploading.");
			}
			return {
				serverUrl: get(state).serverUrl,
				privateKey,
				publicKey: config.publicKey,
				identityGeneration: config.identityGeneration,
			};
		},
		operation: context.operation,
		async withIdentity(operation, action) {
			if (!context.owns(operation)) {
				throw new Error("Invalid session operation.");
			}
			await ready;
			return queue(async () => {
				operation.signal.throwIfAborted();
				if (!context.matches(context.expected(operation), get(state))) {
					throw new Error("Library changed. Start again.");
				}
				return action(identity.credentials());
			});
		},
		create: ({ serverUrl, otc = "", authorizerLibraryId }) =>
			mutate(async (signal) => {
				checkServer(serverUrl);
				if (config.privateKey) {
					throw new Error("A library is already configured.");
				}
				if (!otc.trim() && !authorizerLibraryId) {
					throw new Error("Enter an invitation code from the admin.");
				}
				const created = await generatePrivateKey();
				signal.throwIfAborted();
				try {
					if (authorizerLibraryId) {
						if (!authorizeRegistration) {
							throw new Error("Authenticated registration is unavailable.");
						}
						await authorizeRegistration(
							authorizerLibraryId,
							created.publicKey,
							serverUrl,
							signal,
						);
					} else {
						await registerKey({
							serverUrl,
							publicKey: created.publicKey,
							otc,
							signal,
						});
					}
					signal.throwIfAborted();
					await save(serverUrl, created.privateKey, signal);
				} catch (error) {
					signal.throwIfAborted();
					throw new Error(
						`Registration or local save failed: ${error.message}. The invitation may have been used. No recovery identity was retained; obtain a fresh invitation and restart.`,
					);
				}
			}),
		setServer: (serverUrl) =>
			mutate(async (signal) => {
				checkServer(serverUrl);
				await repository.setConfig(
					{ ...config, serverUrl },
					{ clearUploads: true },
				);
				signal.throwIfAborted();
				config = { ...config, serverUrl };
				privateKey = config.privateKey || "";
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
			let resolved;
			let destination;
			try {
				destination = await mutate(async (ownSignal) => {
					signal.throwIfAborted();
					checkServer(serverUrl);
					if (config.privateKey) {
						throw new Error("A library is already configured.");
					}
					if ((await loadKey(key)).registrationKey !== publicKey) {
						throw new Error("Invalid paired identity.");
					}
					signal.throwIfAborted();
					resolved = await resolvePairing?.({
						serverUrl,
						publicKey,
						signal,
						onInvalidated,
					});
					const existing = resolved;
					ownSignal.throwIfAborted();
					signal.throwIfAborted();
					if (existing) {
						return existing;
					}
					try {
						await save(serverUrl, key, AbortSignal.any([ownSignal, signal]));
						resolved = await resolvePairing?.({
							serverUrl,
							publicKey,
							signal,
							onInvalidated,
							saved: true,
						});
						if (resolved) {
							return resolved;
						}
					} catch (error) {
						if (!(error instanceof ExistingLibraryError) || !resolvePairing) {
							throw error;
						}
						resolved = await resolvePairing({
							serverUrl,
							publicKey,
							signal,
							onInvalidated,
						});
						const raced = resolved;
						ownSignal.throwIfAborted();
						signal.throwIfAborted();
						if (!raced) {
							throw error;
						}
						return raced;
					}
				});
			} catch (error) {
				resolved?.operation.dispose();
				throw error;
			}
			if (destination !== true) {
				return destination;
			}
			const operation = context.operation({ signal, onInvalidated });
			return {
				outcome: "saved",
				operation,
				withIdentity: (action) => identity.withIdentity(operation, action),
			};
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
