import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import type { Credentials } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createPersistence } from "../persistence.ts";
import { bytesToB64url } from "../protocol/bytes.ts";
import type { LoadedKey } from "../protocol/crypto.ts";
import { generatePrivateKey } from "../protocol/identity.ts";
import type { Identity } from "../protocol/recovery.ts";
import {
	exportRecovery,
	MAX_RECOVERY_BYTES,
	openRecovery,
	validateIdentity,
} from "../protocol/recovery.ts";
import { checkServer } from "../protocol/server.ts";
import { requireValue } from "../required.ts";
import type { SessionOperation } from "./identity-context.ts";
import { createSessionContext } from "./identity-context.ts";
export interface SessionState {
	status: "new" | "locked" | "unlocked";
	configured: boolean;
	unlocked: boolean;
	serverUrl: string;
	privateKey: Identity["private_key"] | "";
	publicKey: string;
	epoch: number;
	busy: boolean;
	error: string;
}
export type Session = ReturnType<typeof createSession>;
export interface SessionReader
	extends Readable<
		Pick<SessionState, "configured" | "unlocked" | "busy" | "epoch">
	> {
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
	http?: Pick<typeof api, "registerKey" | "isKeyRegistered">;
} = {}) {
	let identity: Identity | null = null;
	let key: LoadedKey | null = null;
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
	try {
		if (persistence.read()) {
			state.update((v) => ({ ...v, status: "locked" }));
		}
	} catch (error) {
		state.update((v) => ({
			...v,
			status: "locked",
			error: errorMessage(error),
		}));
	}
	function invalidate() {
		epoch++;
		controller.abort();
		controller = new AbortController();
		context.invalidate();
	}
	function publish(patch: Partial<SessionState> = {}) {
		state.update((v) => ({
			...v,
			configured: Boolean(identity),
			serverUrl: identity?.server_url || defaultServerUrl,
			privateKey: identity?.private_key || "",
			epoch,
			...patch,
		}));
	}
	async function action(
		work: (
			signal: AbortSignal,
		) => Promise<number | false | undefined> | number | false | undefined,
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
	async function apply(
		value: {
			identity: Identity;
			key: LoadedKey;
		} | null,
		signal: AbortSignal,
	) {
		const next = value?.identity || null;
		signal.throwIfAborted();
		await persistence.save(next);
		signal.throwIfAborted();
		invalidate();
		identity = next;
		key = value?.key || null;
		publish({
			status: "unlocked",
			unlocked: true,
			publicKey: key?.registrationKey || "",
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
			if (
				!identity ||
				!key ||
				!get(state).unlocked ||
				get(state).busy ||
				disposed
			) {
				throw new Error("Unlock your library first.");
			}
			return { serverUrl: identity.server_url, key };
		},
		async withIdentity<T>(
			operation: SessionOperation,
			work: (
				credentials: Credentials & {
					privateKey: Identity["private_key"];
					publicKey: string;
				},
			) => T | Promise<T>,
		) {
			if (!context.owns(operation)) {
				throw new Error("Invalid session operation.");
			}
			operation.signal.throwIfAborted();
			const result = await work({
				...session.credentials(),
				privateKey: requireValue(identity).private_key,
				publicKey: get(state).publicKey,
			});
			operation.signal.throwIfAborted();
			return result;
		},
		initialize: (password: string) =>
			action(async (signal) => {
				await persistence.initialize(password);
				signal.throwIfAborted();
				publish({ status: "unlocked", unlocked: true });
			}),
		unlock: (password: string) =>
			action(async (signal) => {
				const value = await persistence.unlock(password);
				const next = value ? await validateIdentity(value) : null;
				signal.throwIfAborted();
				identity = next?.identity || null;
				key = next?.key || null;
				publish({
					status: "unlocked",
					unlocked: true,
					publicKey: key?.registrationKey || "",
				});
			}),
		lock() {
			invalidate();
			persistence.lock();
			identity = null;
			key = null;
			publish({
				status: "locked",
				unlocked: false,
				publicKey: "",
				busy: false,
				error: "",
			});
		},
		create: ({ serverUrl, otc }: { serverUrl: string; otc: string }) =>
			action(async (signal) => {
				if (!get(state).unlocked || identity) {
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
				if (!get(state).unlocked || identity) {
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
		async importPairing(
			value: Identity & {
				public_key: Uint8Array;
				signal: AbortSignal;
				onInvalidated?: () => void;
			},
		) {
			const success = await action(async (signal) => {
				if (!get(state).unlocked || identity) {
					throw new Error(
						"A library is already configured or the client is locked.",
					);
				}
				const next = await validateIdentity(value);
				if (next.key.registrationKey !== bytesToB64url(value.public_key)) {
					throw new Error("Invalid paired identity.");
				}
				value.signal?.throwIfAborted();
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
				invalidate();
				identity = null;
				key = null;
				publish({
					status: "new",
					unlocked: false,
					publicKey: "",
					busy: false,
					error: "",
				});
				return true;
			} catch (error) {
				publish({ error: errorMessage(error) });
				return false;
			}
		},
		downloadRecovery: (password: string) =>
			action(async (signal) => {
				if (!identity || !key || !get(state).unlocked) {
					throw new Error("Unlock your library first.");
				}
				const bytes = await exportRecovery(identity, password);
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
			invalidate();
			persistence.lock();
			identity = null;
			key = null;
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
