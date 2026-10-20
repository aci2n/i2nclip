import type { Readable } from "svelte/store";
import { get, type Writable, writable } from "svelte/store";
import type { Credentials, IdentityApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { createPersistence, type SavedIdentity } from "../persistence.ts";
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
	storageError: boolean;
	lockFailed: boolean;
	notice: string;
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
	log: ReturnType<typeof createLog>;
}
interface SessionRuntime {
	state: Writable<SessionState>;
	saved: SavedIdentity | null;
	key: CryptoKey | null;
	library: LoadedIdentity | null;
	candidate: LoadedIdentity | null;
	lifetime: AbortController;
	command: AbortController | null;
	disposed: boolean;
	loaded: boolean;
}

export function createSession({
	persistence = createPersistence(),
	http = api,
	defaultServerUrl = globalThis.location?.origin || "http://localhost:8080",
}: {
	persistence?: ReturnType<typeof createPersistence>;
	http?: IdentityApi;
	defaultServerUrl?: string;
} = {}) {
	const deps: SessionDependencies = {
		persistence,
		http,
		defaultServerUrl,
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
			checking: true,
			storageError: false,
			lockFailed: false,
			notice: "",
		}),
		saved: null,
		key: null,
		library: null,
		candidate: null,
		lifetime,
		command: null,
		disposed: false,
		loaded: false,
	};
	const loaded = loadSession(deps, runtime);

	return {
		subscribe: runtime.state.subscribe,
		loaded,
		retry: loadSession.bind(null, deps, runtime),
		lock: lockSession.bind(null, deps, runtime),
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
	runtime.candidate = null;
}

function installSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	next: SavedIdentity,
	wrapping: CryptoKey,
	identity: LoadedIdentity | null,
	openedRevision = next.revision,
) {
	// Remembering changes the transaction revision, not the unlocked record lifetime.
	if (runtime.saved?.revision !== openedRevision) {
		endSessionLifetime(deps, runtime);
	}
	deps.log.info("installed", { configured: Boolean(identity) });
	runtime.saved = next;
	runtime.key = wrapping;
	runtime.library = identity;
	runtime.candidate = null;
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
		lockFailed: false,
	});
}

function lockedState(deps: SessionDependencies, runtime: SessionRuntime) {
	publishSession(runtime, {
		status: runtime.saved ? "locked" : "new",
		unlocked: false,
		configured: false,
		context: null,
		signal: runtime.lifetime.signal,
		serverUrl: deps.defaultServerUrl,
	});
}

function loadSession(deps: SessionDependencies, runtime: SessionRuntime) {
	return sessionAction(deps, runtime, "load", async (signal) => {
		publishSession(runtime, { checking: true, storageError: false });
		try {
			await readSavedSession(deps, runtime, signal);
		} finally {
			if (!signal.aborted) {
				publishSession(runtime, { checking: false });
			}
		}
	});
}

async function readSavedSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	signal: AbortSignal,
) {
	try {
		const saved = await deps.persistence.read(signal);
		signal.throwIfAborted();
		runtime.saved = saved;
		runtime.loaded = true;
		lockedState(deps, runtime);
	} catch (error) {
		signal.throwIfAborted();
		publishSession(runtime, { status: "locked", storageError: true });
		throw error;
	}
	const saved = runtime.saved;
	if (!saved?.key) {
		return;
	}
	try {
		const key = saved.key;
		if (
			!(key instanceof CryptoKey) ||
			key.extractable ||
			key.algorithm.name !== "AES-GCM" ||
			!key.usages.includes("encrypt") ||
			!key.usages.includes("decrypt")
		) {
			throw new Error("Invalid remembered key.");
		}
		const identity = await openSessionIdentity(deps, saved, key, signal);
		signal.throwIfAborted();
		installSession(deps, runtime, saved, key, identity);
	} catch {
		signal.throwIfAborted();
		publishSession(runtime, {
			error:
				"Remembered access could not be restored. Enter your master password.",
		});
	}
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
	rememberDevice = false,
) {
	return sessionAction(deps, runtime, "initialize", (signal) =>
		performInitializeSession(deps, runtime, password, signal, rememberDevice),
	);
}

function unlockSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	password: string,
	rememberDevice = false,
) {
	return sessionAction(deps, runtime, "unlock", (signal) =>
		performUnlockSession(deps, runtime, password, signal, rememberDevice),
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
	return sessionAction(deps, runtime, "reset", async (signal) => {
		await deps.persistence.reset(signal);
		signal.throwIfAborted();
		endSessionLifetime(deps, runtime);
		runtime.saved = null;
		runtime.loaded = true;
		publishSession(runtime, {
			storageError: false,
			notice: "",
			lockFailed: false,
			checking: false,
		});
		lockedState(deps, runtime);
	});
}

function lockSession(deps: SessionDependencies, runtime: SessionRuntime) {
	if (runtime.disposed) {
		return Promise.resolve(false);
	}
	// Lock interrupts local work, including commands still waiting for crypto.
	runtime.command?.abort();
	runtime.command = null;
	endSessionLifetime(deps, runtime);
	if (runtime.saved) {
		runtime.saved = { ...runtime.saved, key: undefined };
	}
	lockedState(deps, runtime);
	publishSession(runtime, {
		notice: "",
		busy: false,
		checking: false,
		lockFailed: false,
	});
	return sessionAction(deps, runtime, "lock", async (signal) => {
		try {
			const saved = await deps.persistence.lock(signal);
			signal.throwIfAborted();
			runtime.saved = saved;
			runtime.loaded = true;
			lockedState(deps, runtime);
		} catch (error) {
			signal.throwIfAborted();
			publishSession(runtime, { lockFailed: true });
			throw new Error(
				`This tab is locked, but remembered access could not be cleared. Retry Lock. ${errorMessage(error)}`,
			);
		}
	});
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
	deps.persistence.dispose();
	endSessionLifetime(deps, runtime);
	runtime.saved = null;
	publishSession(runtime, {
		status: "locked",
		unlocked: false,
		configured: false,
		context: null,
		signal: runtime.lifetime.signal,
		busy: false,
	});
}

async function performInitializeSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	password: string,
	signal: AbortSignal,
	rememberDevice: boolean,
) {
	if (!runtime.loaded) {
		throw new Error("Wait for browser storage to load, or retry loading it.");
	}
	if (runtime.saved !== null) {
		throw new Error("A master password is already configured.");
	}
	const next = await deps.persistence.protect(null, password, null, signal);
	signal.throwIfAborted();
	await rememberSession(
		deps,
		runtime,
		next.saved,
		next.key,
		null,
		rememberDevice,
		signal,
	);
}

async function performUnlockSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	password: string,
	signal: AbortSignal,
	rememberDevice: boolean,
) {
	if (!runtime.loaded) {
		throw new Error("Retry loading browser storage first.");
	}
	const current = await deps.persistence.read(signal);
	if (!current) {
		throw new Error("No saved identity. Refresh this client to set it up.");
	}
	const wrapping = await deps.persistence.passwordKey(
		current,
		password,
		signal,
	);
	const identity = await openSessionIdentity(deps, current, wrapping, signal);
	await rememberSession(
		deps,
		runtime,
		current,
		wrapping,
		identity,
		rememberDevice,
		signal,
	);
}

async function rememberSession(
	deps: SessionDependencies,
	runtime: SessionRuntime,
	saved: SavedIdentity,
	key: CryptoKey,
	identity: LoadedIdentity | null,
	remember: boolean,
	signal: AbortSignal,
) {
	let next = saved;
	let notice = "";
	try {
		if (remember || saved.key) {
			next = await deps.persistence.remember(
				saved,
				remember ? key : null,
				signal,
			);
		}
	} catch (error) {
		signal.throwIfAborted();
		if (!remember) {
			throw error;
		}
		notice = `Unlocked only in this tab: access could not be remembered. ${errorMessage(error)}`;
	}
	signal.throwIfAborted();
	installSession(deps, runtime, next, key, identity, saved.revision);
	publishSession(runtime, { notice });
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
	const origin = new URL(serverUrl).origin;
	const retry = runtime.candidate?.identity.server_url === origin;
	if (!retry) {
		runtime.candidate = null;
		const { privateKey } = await generatePrivateKey();
		const candidate = await validateIdentity({
			server_url: origin,
			private_key: privateKey,
		});
		signal.throwIfAborted();
		runtime.candidate = candidate;
	}
	const next = runtime.candidate;
	if (!next) {
		throw new Error("Registration identity is unavailable.");
	}
	try {
		const credentials = { serverUrl: origin, key: next.key, signal };
		if (!retry || !(await deps.http.isKeyRegistered(credentials))) {
			signal.throwIfAborted();
			await deps.http.registerKey({ ...credentials, otc });
		}
		signal.throwIfAborted();
		await applyIdentity(deps, runtime, next, signal);
	} catch (error) {
		signal.throwIfAborted();
		throw new Error(
			`${errorMessage(error)} Retry Create in this tab; keep it open until the library is saved.`,
		);
	}
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
		before.saved,
		password,
		identity?.identity ?? null,
		signal,
		Boolean(before.saved.key),
	);
	signal.throwIfAborted();
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
