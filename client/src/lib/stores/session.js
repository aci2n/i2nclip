import { get, writable } from "svelte/store";
import * as api from "../api.js";
import { createPersistence } from "../persistence.js";
import { loadKey } from "../protocol/crypto.js";
import { generatePrivateKey } from "../protocol/identity.js";
import {
	exportRecovery,
	MAX_RECOVERY_BYTES,
	openRecovery,
	validateIdentity,
} from "../protocol/recovery.js";
import { checkServer } from "../protocol/server.js";
import { createSessionContext } from "./identity-context.js";

export function createSession({
	persistence = createPersistence(),
	http = api,
	defaultServerUrl = globalThis.location?.origin || "http://localhost:8080",
} = {}) {
	let identity = null;
	let controller = new AbortController();
	let epoch = 0;
	let disposed = false;
	const state = writable({
		ready: true,
		status: "new",
		configured: false,
		unlocked: false,
		serverUrl: defaultServerUrl,
		privateKey: "",
		publicKey: "",
		epoch,
		busy: false,
		error: "",
	});
	const context = createSessionContext(state);
	try {
		if (persistence.read()) {
			state.update((v) => ({ ...v, status: "locked" }));
		}
	} catch (error) {
		state.update((v) => ({ ...v, status: "locked", error: error.message }));
	}
	function invalidate() {
		epoch++;
		controller.abort();
		controller = new AbortController();
		context.invalidate();
	}
	function publish(patch = {}) {
		state.update((v) => ({
			...v,
			configured: Boolean(identity),
			serverUrl: identity?.serverUrl || defaultServerUrl,
			privateKey: identity?.privateKey || "",
			epoch,
			...patch,
		}));
	}
	async function action(work) {
		if (disposed || get(state).busy) {
			return false;
		}
		state.update((v) => ({ ...v, busy: true, error: "" }));
		const own = epoch;
		const signal = controller.signal;
		try {
			const changedEpoch = await work(signal);
			if (changedEpoch !== epoch) {
				signal.throwIfAborted();
			}
			return !disposed;
		} catch (error) {
			if (!disposed && own === epoch) {
				publish({ error: error.message });
			}
			return false;
		} finally {
			if (!disposed && own === epoch) {
				publish({ busy: false });
			}
		}
	}
	async function apply(value, signal) {
		const next = value ? await validateIdentity(value) : null;
		const loaded = next ? await loadKey(next.privateKey) : null;
		signal.throwIfAborted();
		await persistence.save(next);
		signal.throwIfAborted();
		invalidate();
		identity = next;
		publish({
			status: "unlocked",
			unlocked: true,
			publicKey: loaded?.registrationKey || "",
			busy: false,
			error: "",
		});
		return epoch;
	}
	const session = {
		subscribe: state.subscribe,
		get signal() {
			return controller.signal;
		},
		get epoch() {
			return epoch;
		},
		operation: context.operation,
		credentials() {
			if (!identity || !get(state).unlocked || get(state).busy || disposed) {
				throw new Error("Unlock your library first.");
			}
			return { serverUrl: identity.serverUrl, privateKey: identity.privateKey };
		},
		async withIdentity(operation, work) {
			if (!context.owns(operation)) {
				throw new Error("Invalid session operation.");
			}
			operation.signal.throwIfAborted();
			const result = await work({
				...session.credentials(),
				publicKey: get(state).publicKey,
			});
			operation.signal.throwIfAborted();
			return result;
		},
		initialize: (password) =>
			action(async (signal) => {
				await persistence.initialize(password);
				signal.throwIfAborted();
				publish({ status: "unlocked", unlocked: true });
			}),
		unlock: (password) =>
			action(async (signal) => {
				const value = await persistence.unlock(password);
				const next = value ? await validateIdentity(value) : null;
				const loaded = next ? await loadKey(next.privateKey) : null;
				signal.throwIfAborted();
				identity = next;
				publish({
					status: "unlocked",
					unlocked: true,
					publicKey: loaded?.registrationKey || "",
				});
			}),
		lock() {
			invalidate();
			persistence.lock();
			identity = null;
			publish({
				status: "locked",
				unlocked: false,
				publicKey: "",
				busy: false,
				error: "",
			});
		},
		create: ({ serverUrl, otc }) =>
			action(async (signal) => {
				if (!get(state).unlocked || identity) {
					throw new Error(
						"Forget the current library before creating another.",
					);
				}
				checkServer(serverUrl);
				const { privateKey } = await generatePrivateKey();
				const next = await validateIdentity({ serverUrl, privateKey });
				const key = await loadKey(privateKey);
				await http.registerKey({
					serverUrl: next.serverUrl,
					publicKey: key.registrationKey,
					otc,
					signal,
				});
				return apply(next, signal);
			}),
		restore: (file, password) =>
			action(async (signal) => {
				if (!get(state).unlocked || identity) {
					throw new Error(
						"Forget the current library before restoring another.",
					);
				}
				if (file.size > MAX_RECOVERY_BYTES) {
					throw new Error("Recovery file is too large.");
				}
				const next = await openRecovery(await file.text(), password);
				signal.throwIfAborted();
				if (!(await http.isKeyRegistered({ ...next, signal }))) {
					throw new Error("This identity is not registered on the server.");
				}
				return apply(next, signal);
			}),
		async importPairing(value) {
			const success = await action(async (signal) => {
				if (!get(state).unlocked || identity) {
					throw new Error(
						"A library is already configured or the client is locked.",
					);
				}
				const loaded = await loadKey(value.privateKey);
				if (loaded.registrationKey !== value.publicKey) {
					throw new Error("Invalid paired identity.");
				}
				value.signal?.throwIfAborted();
				return apply(
					{
						serverUrl: value.serverUrl,
						privateKey: value.privateKey,
					},
					AbortSignal.any([signal, value.signal]),
				);
			});
			return success
				? context.operation({
						signal: value.signal,
						onInvalidated: value.onInvalidated,
					})
				: false;
		},
		changePassword: (current, password) =>
			action(async (signal) => {
				await persistence.changePassword(current, password);
				signal.throwIfAborted();
			}),
		forget: () => action((signal) => apply(null, signal)),
		reset() {
			if (disposed) {
				return false;
			}
			try {
				persistence.reset();
				invalidate();
				identity = null;
				publish({
					status: "new",
					unlocked: false,
					publicKey: "",
					busy: false,
					error: "",
				});
				return true;
			} catch (error) {
				publish({ error: error.message });
				return false;
			}
		},
		downloadRecovery: (password) =>
			action(async (signal) => {
				if (!identity || !get(state).unlocked) {
					throw new Error("Unlock your library first.");
				}
				const text = await exportRecovery(identity, password);
				signal.throwIfAborted();
				const url = URL.createObjectURL(
					new Blob([text], { type: "application/json" }),
				);
				try {
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = "i2nclip-recovery.json";
					anchor.click();
				} finally {
					setTimeout(() => URL.revokeObjectURL(url), 1000);
				}
			}),
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			invalidate();
			persistence.lock();
			identity = null;
			publish({
				status: "locked",
				unlocked: false,
				publicKey: "",
				busy: false,
				error: "",
			});
		},
	};
	return session;
}
