import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import type { Credentials, IdentityApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import {
	createPersistence,
	IDENTITY_STORAGE_KEY,
	type SavedIdentity,
} from "../persistence.ts";
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
import {
	createSessionSharing,
	type SessionChannel,
} from "../session-sharing.ts";

// A library consumer never observes changing credentials.
export interface LibraryContext extends Credentials {
	readonly signal: AbortSignal;
}
export interface SessionSnapshot {
	configured: boolean;
	unlocked: boolean;
	busy: boolean;
	signal: AbortSignal;
}
export interface SessionState extends SessionSnapshot {
	status: "new" | "locked" | "unlocked";
	serverUrl: string;
	context: LibraryContext | null;
	error: string;
	checking: boolean;
}
export interface IdentityCredentials extends Credentials {
	privateKey: Identity["private_key"];
	publicKey: string;
}
export interface PairedIdentity extends Identity {
	public_key: Uint8Array;
	signal: AbortSignal;
}
export interface PairingSession extends Readable<SessionState> {
	identity(): IdentityCredentials;
	importPairing(value: PairedIdentity): Promise<boolean>;
}
export type Session = ReturnType<typeof createSession>;

export function createSession({
	persistence = createPersistence(),
	http = api,
	defaultServerUrl = globalThis.location?.origin || "http://localhost:8080",
	events = typeof window === "undefined" ? undefined : window,
	channel,
}: {
	persistence?: ReturnType<typeof createPersistence>;
	http?: IdentityApi;
	defaultServerUrl?: string;
	events?: EventTarget;
	channel?: () => SessionChannel | null;
} = {}) {
	let saved: SavedIdentity | null = null;
	let key: CryptoKey | null = null;
	let library: LoadedIdentity | null = null;
	let lifetime = new AbortController();
	let command: AbortController | null = null;
	let disposed = false;
	const state = writable<SessionState>({
		status: "new",
		configured: false,
		unlocked: false,
		busy: false,
		signal: lifetime.signal,
		serverUrl: defaultServerUrl,
		context: null,
		error: "",
		checking: false,
	});
	function publish(patch: Partial<SessionState>) {
		state.update((value) => ({ ...value, ...patch }));
	}
	const sharing = createSessionSharing({
		channel,
		checking: (value) => {
			if (!disposed) {
				publish({ checking: value });
			}
		},
		lockedRecord: () => (!key && !command ? (saved?.text ?? null) : null),
		current: () => {
			if (!saved || !key || command || disposed) {
				return null;
			}
			try {
				persistence.unchanged(saved.text);
				return { record: saved.text, key };
			} catch {
				externalChange();
				return null;
			}
		},
		accept: async (grant, signal) => {
			const current = saved;
			if (key || command || !current || current.text !== grant.record) {
				return;
			}
			const identity = await open(current, grant.key, signal);
			signal.throwIfAborted();
			sharing.cancel();
			install(current, grant.key, identity);
		},
	});
	function endLifetime() {
		lifetime.abort();
		lifetime = new AbortController();
		key = null;
		library = null;
	}
	function install(
		next: SavedIdentity,
		wrapping: CryptoKey,
		identity: LoadedIdentity | null,
	) {
		if (saved?.text !== next.text) {
			endLifetime();
		}
		saved = next;
		key = wrapping;
		library = identity;
		const context = identity
			? Object.freeze({
					serverUrl: identity.identity.server_url,
					key: identity.key,
					signal: lifetime.signal,
				})
			: null;
		publish({
			status: "unlocked",
			unlocked: true,
			configured: Boolean(identity),
			context,
			signal: lifetime.signal,
			serverUrl: context?.serverUrl || defaultServerUrl,
			error: "",
		});
	}
	function readSaved() {
		let error = "";
		let status: SessionState["status"];
		try {
			saved = persistence.read();
			status = saved ? "locked" : "new";
		} catch (failure) {
			saved = null;
			status = "locked";
			error = errorMessage(failure);
		}
		publish({
			status,
			unlocked: false,
			configured: false,
			context: null,
			signal: lifetime.signal,
			serverUrl: defaultServerUrl,
			busy: false,
			error,
		});
	}

	function externalChange() {
		try {
			if (persistence.text() === (saved?.text ?? null)) {
				return;
			}
		} catch {}
		command?.abort();
		command = null;
		endLifetime();
		readSaved();
		requestAccess();
	}
	function storageChanged(event: Event) {
		if (
			!("key" in event) ||
			(event.key !== null && event.key !== IDENTITY_STORAGE_KEY)
		) {
			return;
		}
		try {
			if (
				"storageArea" in event &&
				!persistence.ownsStorage(event.storageArea)
			) {
				return;
			}
		} catch {}
		externalChange();
	}
	readSaved();
	events?.addEventListener("storage", storageChanged);
	requestAccess();
	function requestAccess() {
		sharing.request(saved?.text ?? null);
	}
	async function action(work: (signal: AbortSignal) => Promise<void>) {
		if (disposed || command) {
			return false;
		}
		sharing.cancel();
		const own = new AbortController();
		command = own;
		publish({ busy: true, error: "" });
		try {
			await work(own.signal);
			own.signal.throwIfAborted();
			return true;
		} catch (error) {
			if (!own.signal.aborted) {
				publish({ error: errorMessage(error) });
			}
			return false;
		} finally {
			if (command === own) {
				command = null;
				if (!disposed) {
					publish({ busy: false });
					if (saved && key) {
						sharing.announce(saved.text);
					}
				}
			}
		}
	}
	async function open(
		saved: SavedIdentity,
		wrapping: CryptoKey,
		signal: AbortSignal,
	) {
		const value = await persistence.open(saved, wrapping, signal);
		const identity = value ? await validateIdentity(value) : null;
		signal.throwIfAborted();
		persistence.unchanged(saved.text);
		return identity;
	}
	function unlocked() {
		if (!saved || !key) {
			throw new Error("Unlock this client first.");
		}
		return { saved, key };
	}
	async function apply(identity: LoadedIdentity | null, signal: AbortSignal) {
		const current = unlocked();
		const next = await persistence.save(
			current.saved,
			current.key,
			identity?.identity ?? null,
			signal,
		);
		signal.throwIfAborted();
		install(next, current.key, identity);
	}
	function requireSetup() {
		unlocked();
		if (library) {
			throw new Error(
				"Forget the current library before creating or restoring another.",
			);
		}
	}
	const session = {
		subscribe: state.subscribe,
		get ready() {
			return !disposed && Boolean(get(state).context) && !get(state).busy;
		},
		identity(): IdentityCredentials {
			if (!library || disposed) {
				throw new Error("Unlock your library first.");
			}
			return {
				serverUrl: library.identity.server_url,
				key: library.key,
				privateKey: library.identity.private_key,
				publicKey: library.key.registrationKey,
			};
		},
		initialize: (password: string) =>
			action(async (signal) => {
				if (persistence.text() !== null) {
					throw new Error("A master password is already configured.");
				}
				const next = await persistence.protect(null, password, null, signal);
				install(next.saved, next.key, null);
			}),
		unlock: (password: string) =>
			action(async (signal) => {
				const current = persistence.read();
				if (!current) {
					throw new Error("Create a master password first.");
				}
				const wrapping = await persistence.passwordKey(
					current,
					password,
					signal,
				);
				const identity = await open(current, wrapping, signal);
				install(current, wrapping, identity);
			}),

		create: ({ serverUrl, otc }: { serverUrl: string; otc: string }) =>
			action(async (signal) => {
				requireSetup();
				checkServer(serverUrl);
				const { privateKey } = await generatePrivateKey();
				const next = await validateIdentity({
					server_url: serverUrl,
					private_key: privateKey,
				});
				signal.throwIfAborted();
				await http.registerKey({
					serverUrl: next.identity.server_url,
					key: next.key,
					otc,
					signal,
				});
				await apply(next, signal);
			}),
		restore: (file: Blob, password: string) =>
			action(async (signal) => {
				requireSetup();
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
				await apply(next, signal);
			}),
		importPairing: (value: PairedIdentity) =>
			action(async (signal) => {
				requireSetup();
				const next = await validateIdentity(value);
				if (next.key.registrationKey !== bytesToB64url(value.public_key)) {
					throw new Error("Invalid paired identity.");
				}
				await apply(next, AbortSignal.any([signal, value.signal]));
			}),
		changePassword: (current: string, password: string) =>
			action(async (signal) => {
				const before = unlocked();
				const currentKey = await persistence.passwordKey(
					before.saved,
					current,
					signal,
				);
				const identity = await open(before.saved, currentKey, signal);
				const next = await persistence.protect(
					before.saved.text,
					password,
					identity?.identity ?? null,
					signal,
				);
				install(next.saved, next.key, identity);
			}),
		forget: () => action((signal) => apply(null, signal)),
		reset() {
			if (disposed || command) {
				return false;
			}
			try {
				sharing.cancel();
				persistence.reset(persistence.text());
				endLifetime();
				readSaved();
				return true;
			} catch (error) {
				publish({ error: errorMessage(error) });
				return false;
			}
		},
		downloadRecovery: (password: string) =>
			action(async (signal) => {
				const current = session.identity();
				const bytes = await exportRecovery(
					{ server_url: current.serverUrl, private_key: current.privateKey },
					password,
				);
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
			command?.abort();
			events?.removeEventListener("storage", storageChanged);
			sharing.dispose();
			endLifetime();
			publish({
				status: "locked",
				unlocked: false,
				configured: false,
				context: null,
				signal: lifetime.signal,
				busy: false,
			});
		},
	};
	return session;
}
