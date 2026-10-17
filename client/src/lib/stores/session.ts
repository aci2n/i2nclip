import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import type { Credentials, IdentityApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createPersistence } from "../persistence.ts";
import { bytesToB64url } from "../protocol/bytes.ts";
import { generatePrivateKey } from "../protocol/identity.ts";
import type { Identity, LoadedIdentity } from "../protocol/recovery.ts";
import {
	exportRecovery,
	MAX_RECOVERY_BYTES,
	openRecovery,
	validateIdentity,
} from "../protocol/recovery.ts";
import { checkServer } from "../protocol/server.ts";
import type { OperationOptions, SessionOperation } from "./identity-context.ts";
import { createSessionContext } from "./identity-context.ts";
export interface SessionSnapshot {
	configured: boolean;
	unlocked: boolean;
	busy: boolean;
	epoch: number;
}
export function libraryReady(value: SessionSnapshot) {
	return value.unlocked && value.configured && !value.busy;
}
export interface SessionState extends SessionSnapshot {
	status: "new" | "locked" | "unlocked";
	serverUrl: string;
	privateKey: Identity["private_key"] | "";
	publicKey: string;
	error: string;
}
export interface IdentityCredentials extends Credentials {
	privateKey: Identity["private_key"];
	publicKey: string;
}
export interface PairedIdentity extends Identity {
	public_key: Uint8Array;
	signal: AbortSignal;
	onInvalidated?: () => void;
}
export interface PairingSessionState extends SessionSnapshot {
	serverUrl: string;
	error: string;
}
export interface PairingSession extends Readable<PairingSessionState> {
	operation(options?: OperationOptions): SessionOperation;
	withIdentity<T>(
		operation: SessionOperation,
		work: (credentials: IdentityCredentials) => T | Promise<T>,
	): Promise<T>;
	importPairing(value: PairedIdentity): Promise<SessionOperation | false>;
}
export type Session = ReturnType<typeof createSession>;
// Invalidation aborts the previous signal before publishing the new epoch.
export interface SessionReader extends Readable<SessionSnapshot> {
	readonly signal: AbortSignal;
	readonly epoch: number;
	credentials(): Credentials;
}

export function createSession({
	persistence = createPersistence(),
	http = api,
	defaultServerUrl = globalThis.location?.origin || "http://localhost:8080",
}: {
	defaultServerUrl?: string;
	persistence?: ReturnType<typeof createPersistence>;
	http?: IdentityApi;
} = {}) {
	let library: LoadedIdentity | null = null;
	let controller = new AbortController();
	let epoch = 0;
	let disposed = false;
	const state = writable<SessionState>({
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
	function invalidate() {
		epoch++;
		controller.abort();
		controller = new AbortController();
		context.invalidate();
	}
	function publish(patch: {
		status?: SessionState["status"];
		busy?: boolean;
		error?: string;
	}) {
		state.update((value) => ({
			...value,
			...patch,
			unlocked: (patch.status ?? value.status) === "unlocked",
			configured: Boolean(library),
			serverUrl: library?.identity.server_url || defaultServerUrl,
			privateKey: library?.identity.private_key || "",
			publicKey: library?.key.registrationKey || "",
			epoch,
		}));
	}
	function savedState(error = ""): { status: "new" | "locked"; error: string } {
		try {
			return { status: persistence.read() ? "locked" : "new", error };
		} catch (failure) {
			return { status: "locked", error: errorMessage(failure) };
		}
	}
	function clear(status: "new" | "locked", error = "") {
		invalidate();
		library = null;
		publish({ status, busy: false, error });
	}
	async function action(
		work: (
			signal: AbortSignal,
		) => Promise<number | undefined> | number | undefined,
	) {
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
				publish({ error: errorMessage(error) });
			}
			return false;
		} finally {
			if (!disposed && own === epoch) {
				publish({ busy: false });
			}
		}
	}
	async function apply(value: LoadedIdentity | null, signal: AbortSignal) {
		const next = value ? value.identity : null;
		signal.throwIfAborted();
		await persistence.save(next);
		signal.throwIfAborted();
		invalidate();
		library = value;
		publish({
			status: "unlocked",
			busy: false,
			error: "",
		});
		return epoch;
	}
	function currentIdentity() {
		if (!library || !get(state).unlocked || get(state).busy || disposed) {
			throw new Error("Unlock your library first.");
		}
		return library;
	}
	publish(savedState());
	const stopWatching = persistence.onExternalChange(() => {
		persistence.lock();
		const { status, error } = savedState(
			"Saved identity changed in another tab. Unlock this client again.",
		);
		clear(status, error);
	});
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
			const current = currentIdentity();
			return { serverUrl: current.identity.server_url, key: current.key };
		},
		async withIdentity<T>(
			operation: SessionOperation,
			work: (credentials: IdentityCredentials) => T | Promise<T>,
		) {
			if (!context.owns(operation)) {
				throw new Error("Invalid session operation.");
			}
			operation.signal.throwIfAborted();
			const current = currentIdentity();
			const result = await work({
				serverUrl: current.identity.server_url,
				key: current.key,
				privateKey: current.identity.private_key,
				publicKey: current.key.registrationKey,
			});
			operation.signal.throwIfAborted();
			return result;
		},
		initialize: (password: string) =>
			action(async (signal) => {
				await persistence.initialize(password);
				signal.throwIfAborted();
				publish({ status: "unlocked" });
			}),
		unlock: (password: string) =>
			action(async (signal) => {
				const value = await persistence.unlock(password);
				const next = value ? await validateIdentity(value) : null;
				signal.throwIfAborted();
				library = next;
				publish({ status: "unlocked" });
			}),
		lock() {
			persistence.lock();
			clear("locked");
		},
		create: ({ serverUrl, otc }: { serverUrl: string; otc: string }) =>
			action(async (signal) => {
				if (!get(state).unlocked || library) {
					throw new Error(
						"Forget the current library before creating another.",
					);
				}
				checkServer(serverUrl);
				const { privateKey } = await generatePrivateKey();
				const next = await validateIdentity({
					server_url: serverUrl,
					private_key: privateKey,
				});
				await http.registerKey({
					serverUrl: next.identity.server_url,
					key: next.key,
					otc,
					signal,
				});
				return apply(next, signal);
			}),
		restore: (file: Blob, password: string) =>
			action(async (signal) => {
				if (!get(state).unlocked || library) {
					throw new Error(
						"Forget the current library before restoring another.",
					);
				}
				if (file.size > MAX_RECOVERY_BYTES) {
					throw new Error("Recovery file is too large.");
				}
				const next = await openRecovery(
					new Uint8Array(await file.arrayBuffer()),
					password,
				);
				signal.throwIfAborted();
				if (
					!(await http.isKeyRegistered({
						serverUrl: next.identity.server_url,
						key: next.key,
						signal,
					}))
				) {
					throw new Error("This identity is not registered on the server.");
				}
				return apply(next, signal);
			}),
		async importPairing(value: PairedIdentity) {
			const success = await action(async (signal) => {
				if (!get(state).unlocked || library) {
					throw new Error(
						"A library is already configured or the client is locked.",
					);
				}
				const next = await validateIdentity(value);
				if (next.key.registrationKey !== bytesToB64url(value.public_key)) {
					throw new Error("Invalid paired identity.");
				}
				value.signal.throwIfAborted();
				return apply(next, AbortSignal.any([signal, value.signal]));
			});
			return success
				? context.operation({
						signal: value.signal,
						onInvalidated: value.onInvalidated,
					})
				: false;
		},
		changePassword: (current: string, password: string) =>
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
				clear("new");
				return true;
			} catch (error) {
				publish({ error: errorMessage(error) });
				return false;
			}
		},
		downloadRecovery: (password: string) =>
			action(async (signal) => {
				if (!library || !get(state).unlocked) {
					throw new Error("Unlock your library first.");
				}
				const bytes = await exportRecovery(library.identity, password);
				signal.throwIfAborted();
				const url = URL.createObjectURL(
					new Blob([bytes], { type: "application/msgpack" }),
				);
				try {
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = "i2nclip-recovery.msgpack";
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
			stopWatching();
			session.lock();
		},
	};
	return session;
}
