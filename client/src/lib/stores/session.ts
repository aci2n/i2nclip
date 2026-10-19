import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import type { Credentials, IdentityApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
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

interface SessionDependencies {
	persistence: ReturnType<typeof createPersistence>;
	http: IdentityApi;
	defaultServerUrl: string;
	events?: EventTarget;
	log: ReturnType<typeof createLog>;
}
interface SessionRuntime {
	state: ReturnType<typeof writable<SessionState>>;
	saved: SavedIdentity | null;
	key: CryptoKey | null;
	library: LoadedIdentity | null;
	lifetime: AbortController;
	command: AbortController | null;
	disposed: boolean;
	// Attached before reading saved identity or requesting access. Channel setup
	// can synchronously report failure through the checking callback.
	sharing: ReturnType<typeof createSessionSharing> | null;
	storageChanged: (event: Event) => void;
}
interface SharedGrant {
	record: string;
	key: CryptoKey;
}

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
	const deps: SessionDependencies = {
		persistence,
		http,
		defaultServerUrl,
		events,
		log: createLog("session"),
	};
	const lifetime = new AbortController();
	const runtime: SessionRuntime = {
		state: writable<SessionState>({
			status: "new",
			configured: false,
			unlocked: false,
			busy: false,
			signal: lifetime.signal,
			serverUrl: defaultServerUrl,
			context: null,
			error: "",
			checking: false,
		}),
		saved: null,
		key: null,
		library: null,
		lifetime,
		command: null,
		disposed: false,
		sharing: null,
		storageChanged: (event) => sessionStorageChanged(deps, runtime, event),
	};
	runtime.sharing = createSessionSharing({
		channel,
		checking: (value) => sharingChecking(runtime, value),
		lockedRecord: () => lockedRecord(runtime),
		current: () => currentGrant(deps, runtime),
		accept: (grant, signal) => acceptGrant(deps, runtime, grant, signal),
	});
	readSavedSession(deps, runtime);
	events?.addEventListener("storage", runtime.storageChanged);
	requestSessionAccess(runtime);

	return {
		subscribe: runtime.state.subscribe,
		get ready() {
			return (
				!runtime.disposed &&
				Boolean(get(runtime.state).context) &&
				!get(runtime.state).busy
			);
		},
		identity: sessionIdentity.bind(null, runtime),
		initialize: initializeSession.bind(null, deps, runtime),
		unlock: unlockSession.bind(null, deps, runtime),
		create: createIdentity.bind(null, deps, runtime),
		restore: restoreIdentity.bind(null, deps, runtime),
		importPairing: importPairedIdentity.bind(null, deps, runtime),
		changePassword: changeSessionPassword.bind(null, deps, runtime),
		forget: forgetIdentity.bind(null, deps, runtime),
		reset: resetSession.bind(null, deps, runtime),
		downloadRecovery: downloadSessionRecovery.bind(null, deps, runtime),
		dispose: disposeSession.bind(null, deps, runtime),
	};
}

function publishSession(runtime: SessionRuntime, patch: Partial<SessionState>) {
	runtime.state.update((value) => ({ ...value, ...patch }));
}

function endSessionLifetime(
	deps: SessionDependencies,
	runtime: SessionRuntime,
) {
	deps.log.debug("lifetime-ended");
	runtime.lifetime.abort();
	runtime.lifetime = new AbortController();
	runtime.key = null;
	runtime.library = null;
}

function installSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	next: SavedIdentity,
	wrapping: CryptoKey,
	identity: LoadedIdentity | null,
) {
	if (runtime.saved?.text !== next.text) {
		endSessionLifetime(deps, runtime);
	}
	deps.log.info("installed", { configured: Boolean(identity) });
	runtime.saved = next;
	runtime.key = wrapping;
	runtime.library = identity;
	const context = identity
		? Object.freeze({
				serverUrl: identity.identity.server_url,
				key: identity.key,
				signal: runtime.lifetime.signal,
			})
		: null;
	publishSession(runtime, {
		status: "unlocked",
		unlocked: true,
		configured: Boolean(identity),
		context,
		signal: runtime.lifetime.signal,
		serverUrl: context?.serverUrl || deps.defaultServerUrl,
		error: "",
	});
}

function readSavedSession(deps: SessionDependencies, runtime: SessionRuntime) {
	let error = "";
	let status: SessionState["status"];
	try {
		runtime.saved = deps.persistence.read();
		status = runtime.saved ? "locked" : "new";
	} catch (failure) {
		deps.log.error("read-failed", failureFields(failure));
		runtime.saved = null;
		status = "locked";
		error = errorMessage(failure);
	}
	publishSession(runtime, {
		status,
		unlocked: false,
		configured: false,
		context: null,
		signal: runtime.lifetime.signal,
		serverUrl: deps.defaultServerUrl,
		busy: false,
		error,
	});
}

function externalSessionChange(
	deps: SessionDependencies,
	runtime: SessionRuntime,
) {
	try {
		if (deps.persistence.text() === (runtime.saved?.text ?? null)) {
			return;
		}
	} catch {}
	deps.log.info("storage-invalidated");
	runtime.command?.abort();
	runtime.command = null;
	endSessionLifetime(deps, runtime);
	readSavedSession(deps, runtime);
	requestSessionAccess(runtime);
}

function sessionStorageChanged(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	event: Event,
) {
	if (
		!("key" in event) ||
		(event.key !== null && event.key !== IDENTITY_STORAGE_KEY)
	) {
		return;
	}
	try {
		if (
			"storageArea" in event &&
			!deps.persistence.ownsStorage(event.storageArea)
		) {
			return;
		}
	} catch {}
	externalSessionChange(deps, runtime);
}

function requestSessionAccess(runtime: SessionRuntime) {
	runtime.sharing?.request(runtime.saved?.text ?? null);
}

async function sessionAction(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	name: string,
	work: (signal: AbortSignal) => Promise<void>,
) {
	if (runtime.disposed || runtime.command) {
		deps.log.debug("rejected", {
			action: name,
			reason: runtime.disposed ? "disposed" : "busy",
		});
		return false;
	}
	const operation = deps.log.operation();
	deps.log.info("started", { action: name, operation });
	runtime.sharing?.cancel();
	const own = new AbortController();
	runtime.command = own;
	publishSession(runtime, { busy: true, error: "" });
	try {
		await work(own.signal);
		own.signal.throwIfAborted();
		deps.log.info("completed", { action: name, operation });
		return true;
	} catch (error) {
		if (own.signal.aborted) {
			deps.log.debug("cancelled", { action: name, operation });
		} else {
			deps.log.error("failed", {
				action: name,
				operation,
				...failureFields(error),
			});
		}
		if (!own.signal.aborted) {
			publishSession(runtime, { error: errorMessage(error) });
		}
		return false;
	} finally {
		if (runtime.command === own) {
			runtime.command = null;
			if (!runtime.disposed) {
				publishSession(runtime, { busy: false });
				if (runtime.saved && runtime.key) {
					runtime.sharing?.announce(runtime.saved.text);
				}
			}
		}
	}
}

async function openSessionIdentity(
	deps: SessionDependencies,
	saved: SavedIdentity,
	wrapping: CryptoKey,
	signal: AbortSignal,
) {
	const value = await deps.persistence.open(saved, wrapping, signal);
	const identity = value ? await validateIdentity(value) : null;
	signal.throwIfAborted();
	deps.persistence.unchanged(saved.text);
	return identity;
}

function unlockedSession(runtime: SessionRuntime) {
	if (!runtime.saved || !runtime.key) {
		throw new Error("Unlock this client first.");
	}
	return { saved: runtime.saved, key: runtime.key };
}

async function applyIdentity(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	identity: LoadedIdentity | null,
	signal: AbortSignal,
) {
	const current = unlockedSession(runtime);
	const next = await deps.persistence.save(
		current.saved,
		current.key,
		identity?.identity ?? null,
		signal,
	);
	signal.throwIfAborted();
	installSession(deps, runtime, next, current.key, identity);
}

function requireSessionSetup(runtime: SessionRuntime) {
	unlockedSession(runtime);
	if (runtime.library) {
		throw new Error(
			"Forget the current library before creating or restoring another.",
		);
	}
}

function sessionIdentity(runtime: SessionRuntime): IdentityCredentials {
	if (!runtime.library || runtime.disposed) {
		throw new Error("Unlock your library first.");
	}
	return {
		serverUrl: runtime.library.identity.server_url,
		key: runtime.library.key,
		privateKey: runtime.library.identity.private_key,
		publicKey: runtime.library.key.registrationKey,
	};
}

function initializeSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	password: string,
) {
	return sessionAction(deps, runtime, "initialize", (signal) =>
		performInitializeSession(deps, runtime, password, signal),
	);
}

function unlockSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	password: string,
) {
	return sessionAction(deps, runtime, "unlock", (signal) =>
		performUnlockSession(deps, runtime, password, signal),
	);
}

function createIdentity(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	{
		serverUrl,
		otc,
	}: {
		serverUrl: string;
		otc: string;
	},
) {
	return sessionAction(deps, runtime, "create", (signal) =>
		performCreateIdentity(deps, runtime, { serverUrl, otc }, signal),
	);
}

function restoreIdentity(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	file: Blob,
	password: string,
) {
	return sessionAction(deps, runtime, "restore", (signal) =>
		performRestoreIdentity(deps, runtime, file, password, signal),
	);
}

function importPairedIdentity(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	value: PairedIdentity,
) {
	return sessionAction(deps, runtime, "importPairing", (signal) =>
		performImportPairedIdentity(deps, runtime, value, signal),
	);
}

function changeSessionPassword(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	current: string,
	password: string,
) {
	return sessionAction(deps, runtime, "changePassword", (signal) =>
		performChangeSessionPassword(deps, runtime, current, password, signal),
	);
}

function forgetIdentity(deps: SessionDependencies, runtime: SessionRuntime) {
	return sessionAction(deps, runtime, "forget", (signal) =>
		applyIdentity(deps, runtime, null, signal),
	);
}

function resetSession(deps: SessionDependencies, runtime: SessionRuntime) {
	deps.log.info("reset-requested");
	if (runtime.disposed || runtime.command) {
		return false;
	}
	try {
		runtime.sharing?.cancel();
		deps.persistence.reset(deps.persistence.text());
		endSessionLifetime(deps, runtime);
		readSavedSession(deps, runtime);
		deps.log.info("reset-completed");
		return true;
	} catch (error) {
		deps.log.error("reset-failed", failureFields(error));
		publishSession(runtime, { error: errorMessage(error) });
		return false;
	}
}

function downloadSessionRecovery(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	password: string,
) {
	return sessionAction(deps, runtime, "downloadRecovery", (signal) =>
		performDownloadSessionRecovery(runtime, password, signal),
	);
}

function disposeSession(deps: SessionDependencies, runtime: SessionRuntime) {
	if (runtime.disposed) {
		return;
	}
	deps.log.debug("disposed");
	runtime.disposed = true;
	runtime.command?.abort();
	deps.events?.removeEventListener("storage", runtime.storageChanged);
	runtime.sharing?.dispose();
	endSessionLifetime(deps, runtime);
	publishSession(runtime, {
		status: "locked",
		unlocked: false,
		configured: false,
		context: null,
		signal: runtime.lifetime.signal,
		busy: false,
	});
}

function sharingChecking(runtime: SessionRuntime, value: boolean) {
	if (!runtime.disposed) {
		publishSession(runtime, { checking: value });
	}
}

function lockedRecord(runtime: SessionRuntime) {
	return !runtime.key && !runtime.command
		? (runtime.saved?.text ?? null)
		: null;
}

function currentGrant(deps: SessionDependencies, runtime: SessionRuntime) {
	if (!runtime.saved || !runtime.key || runtime.command || runtime.disposed) {
		return null;
	}
	try {
		deps.persistence.unchanged(runtime.saved.text);
		return { record: runtime.saved.text, key: runtime.key };
	} catch {
		externalSessionChange(deps, runtime);
		return null;
	}
}

async function acceptGrant(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	grant: SharedGrant,
	signal: AbortSignal,
) {
	const current = runtime.saved;
	if (
		runtime.key ||
		runtime.command ||
		!current ||
		current.text !== grant.record
	) {
		return;
	}
	const identity = await openSessionIdentity(deps, current, grant.key, signal);
	signal.throwIfAborted();
	runtime.sharing?.cancel();
	installSession(deps, runtime, current, grant.key, identity);
	deps.log.info("shared-unlock-completed");
}

async function performInitializeSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	password: string,
	signal: AbortSignal,
) {
	if (deps.persistence.text() !== null) {
		throw new Error("A master password is already configured.");
	}
	const next = await deps.persistence.protect(null, password, null, signal);
	installSession(deps, runtime, next.saved, next.key, null);
}

async function performUnlockSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	password: string,
	signal: AbortSignal,
) {
	const current = deps.persistence.read();
	if (!current) {
		throw new Error("Create a master password first.");
	}
	const wrapping = await deps.persistence.passwordKey(
		current,
		password,
		signal,
	);
	const identity = await openSessionIdentity(deps, current, wrapping, signal);
	installSession(deps, runtime, current, wrapping, identity);
}

async function performCreateIdentity(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	{
		serverUrl,
		otc,
	}: {
		serverUrl: string;
		otc: string;
	},
	signal: AbortSignal,
) {
	requireSessionSetup(runtime);
	checkServer(serverUrl);
	const { privateKey } = await generatePrivateKey();
	const next = await validateIdentity({
		server_url: serverUrl,
		private_key: privateKey,
	});
	signal.throwIfAborted();
	await deps.http.registerKey({
		serverUrl: next.identity.server_url,
		key: next.key,
		otc,
		signal,
	});
	await applyIdentity(deps, runtime, next, signal);
}

async function performRestoreIdentity(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	file: Blob,
	password: string,
	signal: AbortSignal,
) {
	requireSessionSetup(runtime);
	if (file.size > MAX_RECOVERY_BYTES) {
		throw new Error("Recovery file is too large.");
	}
	const next = await openRecovery(
		new Uint8Array(await file.arrayBuffer()),
		password,
	);
	signal.throwIfAborted();
	if (
		!(await deps.http.isKeyRegistered({
			serverUrl: next.identity.server_url,
			key: next.key,
			signal,
		}))
	) {
		throw new Error("This identity is not registered on the server.");
	}
	await applyIdentity(deps, runtime, next, signal);
}

async function performImportPairedIdentity(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	value: PairedIdentity,
	signal: AbortSignal,
) {
	requireSessionSetup(runtime);
	const next = await validateIdentity(value);
	if (next.key.registrationKey !== bytesToB64url(value.public_key)) {
		throw new Error("Invalid paired identity.");
	}
	await applyIdentity(
		deps,
		runtime,
		next,
		AbortSignal.any([signal, value.signal]),
	);
}

async function performChangeSessionPassword(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	current: string,
	password: string,
	signal: AbortSignal,
) {
	const before = unlockedSession(runtime);
	const currentKey = await deps.persistence.passwordKey(
		before.saved,
		current,
		signal,
	);
	const identity = await openSessionIdentity(
		deps,
		before.saved,
		currentKey,
		signal,
	);
	const next = await deps.persistence.protect(
		before.saved.text,
		password,
		identity?.identity ?? null,
		signal,
	);
	installSession(deps, runtime, next.saved, next.key, identity);
}

async function performDownloadSessionRecovery(
	runtime: SessionRuntime,
	password: string,
	signal: AbortSignal,
) {
	const current = sessionIdentity(runtime);
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
}
