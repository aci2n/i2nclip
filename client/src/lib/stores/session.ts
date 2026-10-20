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
export function createSession(
	options: {
		persistence?: ReturnType<typeof createPersistence>;
		http?: IdentityApi;
		defaultServerUrl?: string;
	} = {},
): Pick<SessionStoreImpl, keyof SessionStoreImpl> {
	return new SessionStoreImpl(options);
}

class SessionStoreImpl {
	private readonly persistence: ReturnType<typeof createPersistence>;
	private readonly http: IdentityApi;
	private readonly defaultServerUrl: string;
	private readonly log: ReturnType<typeof createLog>;
	private readonly state: Writable<SessionState>;
	private saved: SavedIdentity | null;
	private key: CryptoKey | null;
	private library: LoadedIdentity | null;
	private candidate: LoadedIdentity | null;
	private lifetime: AbortController;
	private command: AbortController | null;
	private disposed: boolean;
	private loaded: boolean;
	private initialLoad?: Promise<boolean>;

	readonly subscribe: Writable<SessionState>["subscribe"];
	readonly load = this.loadInitialSession.bind(this);
	readonly retry = this.loadSession.bind(this);
	readonly lock = this.lockSession.bind(this);
	get ready() {
		return (
			!this.disposed &&
			Boolean(get(this.state).context) &&
			!get(this.state).busy
		);
	}
	readonly identity = this.sessionIdentity.bind(this);
	readonly initialize = this.initializeSession.bind(this);
	readonly unlock = this.unlockSession.bind(this);
	readonly create = this.createIdentity.bind(this);
	readonly restore = this.restoreIdentity.bind(this);
	readonly importPairing = this.importPairedIdentity.bind(this);
	readonly changePassword = this.changeSessionPassword.bind(this);
	readonly forget = this.forgetIdentity.bind(this);
	readonly reset = this.resetSession.bind(this);
	readonly downloadRecovery = this.downloadSessionRecovery.bind(this);
	readonly dispose = this.disposeSession.bind(this);

	constructor({
		persistence = createPersistence(),
		http = api,
		defaultServerUrl = globalThis.location?.origin || "http://localhost:8080",
	}: {
		persistence?: ReturnType<typeof createPersistence>;
		http?: IdentityApi;
		defaultServerUrl?: string;
	} = {}) {
		this.persistence = persistence;
		this.http = http;
		this.defaultServerUrl = defaultServerUrl;
		this.log = createLog("session");
		const lifetime = new AbortController();
		this.state = writable<SessionState>({
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
		});
		this.subscribe = this.state.subscribe;
		this.saved = null;
		this.key = null;
		this.library = null;
		this.candidate = null;
		this.lifetime = lifetime;
		this.command = null;
		this.disposed = false;
		this.loaded = false;
	}

	private loadInitialSession() {
		this.initialLoad ??= this.loadSession();
		return this.initialLoad;
	}

	private publishSession(patch: Partial<SessionState>) {
		this.state.update((value) => ({ ...value, ...patch }));
	}

	private endSessionLifetime() {
		this.log.debug("lifetime-ended");
		this.lifetime.abort();
		this.lifetime = new AbortController();
		this.key = null;
		this.library = null;
		this.candidate = null;
	}

	private installSession(
		next: SavedIdentity,
		wrapping: CryptoKey,
		identity: LoadedIdentity | null,
		openedRevision = next.revision,
	) {
		// Remembering changes the transaction revision, not the unlocked record lifetime.
		if (this.saved?.revision !== openedRevision) {
			this.endSessionLifetime();
		}
		this.log.info("installed", { configured: Boolean(identity) });
		this.saved = next;
		this.key = wrapping;
		this.library = identity;
		this.candidate = null;
		const context = identity
			? Object.freeze({
					serverUrl: identity.identity.server_url,
					key: identity.key,
					signal: this.lifetime.signal,
				})
			: null;
		this.publishSession({
			status: "unlocked",
			unlocked: true,
			configured: Boolean(identity),
			context,
			signal: this.lifetime.signal,
			serverUrl: context?.serverUrl || this.defaultServerUrl,
			error: "",
			lockFailed: false,
		});
	}

	private lockedState() {
		this.publishSession({
			status: this.saved ? "locked" : "new",
			unlocked: false,
			configured: false,
			context: null,
			signal: this.lifetime.signal,
			serverUrl: this.defaultServerUrl,
		});
	}

	private loadSession() {
		return this.sessionAction("load", async (signal) => {
			this.publishSession({ checking: true, storageError: false });
			try {
				await this.readSavedSession(signal);
			} finally {
				if (!signal.aborted) {
					this.publishSession({ checking: false });
				}
			}
		});
	}

	private async readSavedSession(signal: AbortSignal) {
		try {
			const saved = await this.persistence.read(signal);
			signal.throwIfAborted();
			this.saved = saved;
			this.loaded = true;
			this.lockedState();
		} catch (error) {
			signal.throwIfAborted();
			this.publishSession({ status: "locked", storageError: true });
			throw error;
		}
		const saved = this.saved;
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
			const identity = await this.openSessionIdentity(saved, key, signal);
			signal.throwIfAborted();
			this.installSession(saved, key, identity);
		} catch {
			signal.throwIfAborted();
			this.publishSession({
				error:
					"Remembered access could not be restored. Enter your master password.",
			});
		}
	}

	private async sessionAction(
		name: string,
		work: (signal: AbortSignal) => Promise<void>,
	) {
		if (this.disposed || this.command) {
			this.log.debug("rejected", {
				action: name,
				reason: this.disposed ? "disposed" : "busy",
			});
			return false;
		}
		const operation = this.log.operation();
		this.log.info("started", { action: name, operation });
		const own = new AbortController();
		this.command = own;
		this.publishSession({ busy: true, error: "" });
		try {
			await work(own.signal);
			own.signal.throwIfAborted();
			this.log.info("completed", { action: name, operation });
			return true;
		} catch (error) {
			if (own.signal.aborted) {
				this.log.debug("cancelled", { action: name, operation });
			} else {
				this.log.error("failed", {
					action: name,
					operation,
					...failureFields(error),
				});
			}
			if (!own.signal.aborted) {
				this.publishSession({ error: errorMessage(error) });
			}
			return false;
		} finally {
			if (this.command === own) {
				this.command = null;
				if (!this.disposed) {
					this.publishSession({ busy: false });
				}
			}
		}
	}

	private async openSessionIdentity(
		saved: SavedIdentity,
		wrapping: CryptoKey,
		signal: AbortSignal,
	) {
		const value = await this.persistence.open(saved, wrapping, signal);
		const identity = value ? await validateIdentity(value) : null;
		signal.throwIfAborted();
		return identity;
	}

	private unlockedSession() {
		if (!this.saved || !this.key) {
			throw new Error("Unlock this client first.");
		}
		return { saved: this.saved, key: this.key };
	}

	private async applyIdentity(
		identity: LoadedIdentity | null,
		signal: AbortSignal,
	) {
		const current = this.unlockedSession();
		const next = await this.persistence.save(
			current.saved,
			current.key,
			identity?.identity ?? null,
			signal,
		);
		signal.throwIfAborted();
		this.installSession(next, current.key, identity);
	}

	private requireSessionSetup() {
		this.unlockedSession();
		if (this.library) {
			throw new Error(
				"Forget the current library before creating or restoring another.",
			);
		}
	}

	private sessionIdentity(): IdentityCredentials {
		if (!this.library || this.disposed) {
			throw new Error("Unlock your library first.");
		}
		return {
			serverUrl: this.library.identity.server_url,
			key: this.library.key,
			privateKey: this.library.identity.private_key,
			publicKey: this.library.key.registrationKey,
		};
	}

	private initializeSession(password: string, rememberDevice = false) {
		return this.sessionAction("initialize", (signal) =>
			this.performInitializeSession(password, signal, rememberDevice),
		);
	}

	private unlockSession(password: string, rememberDevice = false) {
		return this.sessionAction("unlock", (signal) =>
			this.performUnlockSession(password, signal, rememberDevice),
		);
	}

	private createIdentity({
		serverUrl,
		otc,
	}: {
		serverUrl: string;
		otc: string;
	}) {
		return this.sessionAction("create", (signal) =>
			this.performCreateIdentity({ serverUrl, otc }, signal),
		);
	}

	private restoreIdentity(file: Blob, password: string) {
		return this.sessionAction("restore", (signal) =>
			this.performRestoreIdentity(file, password, signal),
		);
	}

	private importPairedIdentity(value: PairedIdentity) {
		return this.sessionAction("importPairing", (signal) =>
			this.performImportPairedIdentity(value, signal),
		);
	}

	private changeSessionPassword(current: string, password: string) {
		return this.sessionAction("changePassword", (signal) =>
			this.performChangeSessionPassword(current, password, signal),
		);
	}

	private forgetIdentity() {
		return this.sessionAction("forget", (signal) =>
			this.applyIdentity(null, signal),
		);
	}

	private resetSession() {
		return this.sessionAction("reset", async (signal) => {
			await this.persistence.reset(signal);
			signal.throwIfAborted();
			this.endSessionLifetime();
			this.saved = null;
			this.loaded = true;
			this.publishSession({
				storageError: false,
				notice: "",
				lockFailed: false,
				checking: false,
			});
			this.lockedState();
		});
	}

	private lockSession() {
		if (this.disposed) {
			return Promise.resolve(false);
		}
		// Lock interrupts local work, including commands still waiting for crypto.
		this.command?.abort();
		this.command = null;
		this.endSessionLifetime();
		if (this.saved) {
			this.saved = { ...this.saved, key: undefined };
		}
		this.lockedState();
		this.publishSession({
			notice: "",
			busy: false,
			checking: false,
			lockFailed: false,
		});
		return this.sessionAction("lock", async (signal) => {
			try {
				const saved = await this.persistence.lock(signal);
				signal.throwIfAborted();
				this.saved = saved;
				this.loaded = true;
				this.lockedState();
			} catch (error) {
				signal.throwIfAborted();
				this.publishSession({ lockFailed: true });
				throw new Error(
					`This tab is locked, but remembered access could not be cleared. Retry Lock. ${errorMessage(error)}`,
				);
			}
		});
	}

	private downloadSessionRecovery(password: string) {
		return this.sessionAction("downloadRecovery", (signal) =>
			this.performDownloadSessionRecovery(password, signal),
		);
	}

	private disposeSession() {
		if (this.disposed) {
			return;
		}
		this.log.debug("disposed");
		this.disposed = true;
		this.command?.abort();
		this.persistence.dispose();
		this.endSessionLifetime();
		this.saved = null;
		this.publishSession({
			status: "locked",
			unlocked: false,
			configured: false,
			context: null,
			signal: this.lifetime.signal,
			busy: false,
		});
	}

	private async performInitializeSession(
		password: string,
		signal: AbortSignal,
		rememberDevice: boolean,
	) {
		if (!this.loaded) {
			throw new Error("Wait for browser storage to load, or retry loading it.");
		}
		if (this.saved !== null) {
			throw new Error("A master password is already configured.");
		}
		const next = await this.persistence.protect(null, password, null, signal);
		signal.throwIfAborted();
		await this.rememberSession(
			next.saved,
			next.key,
			null,
			rememberDevice,
			signal,
		);
	}

	private async performUnlockSession(
		password: string,
		signal: AbortSignal,
		rememberDevice: boolean,
	) {
		if (!this.loaded) {
			throw new Error("Retry loading browser storage first.");
		}
		const current = await this.persistence.read(signal);
		if (!current) {
			throw new Error("No saved identity. Refresh this client to set it up.");
		}
		const wrapping = await this.persistence.passwordKey(
			current,
			password,
			signal,
		);
		const identity = await this.openSessionIdentity(current, wrapping, signal);
		await this.rememberSession(
			current,
			wrapping,
			identity,
			rememberDevice,
			signal,
		);
	}

	private async rememberSession(
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
				next = await this.persistence.remember(
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
		this.installSession(next, key, identity, saved.revision);
		this.publishSession({ notice });
	}

	private async performCreateIdentity(
		{
			serverUrl,
			otc,
		}: {
			serverUrl: string;
			otc: string;
		},
		signal: AbortSignal,
	) {
		this.requireSessionSetup();
		checkServer(serverUrl);
		const origin = new URL(serverUrl).origin;
		const retry = this.candidate?.identity.server_url === origin;
		if (!retry) {
			this.candidate = null;
			const { privateKey } = await generatePrivateKey();
			const candidate = await validateIdentity({
				server_url: origin,
				private_key: privateKey,
			});
			signal.throwIfAborted();
			this.candidate = candidate;
		}
		const next = this.candidate;
		if (!next) {
			throw new Error("Registration identity is unavailable.");
		}
		try {
			const credentials = { serverUrl: origin, key: next.key, signal };
			if (!retry || !(await this.http.isKeyRegistered(credentials))) {
				signal.throwIfAborted();
				await this.http.registerKey({ ...credentials, otc });
			}
			signal.throwIfAborted();
			await this.applyIdentity(next, signal);
		} catch (error) {
			signal.throwIfAborted();
			throw new Error(
				`${errorMessage(error)} Retry Create in this tab; keep it open until the library is saved.`,
			);
		}
	}

	private async performRestoreIdentity(
		file: Blob,
		password: string,
		signal: AbortSignal,
	) {
		this.requireSessionSetup();
		if (file.size > MAX_RECOVERY_BYTES) {
			throw new Error("Recovery file is too large.");
		}
		const next = await openRecovery(
			new Uint8Array(await file.arrayBuffer()),
			password,
		);
		signal.throwIfAborted();
		if (
			!(await this.http.isKeyRegistered({
				serverUrl: next.identity.server_url,
				key: next.key,
				signal,
			}))
		) {
			throw new Error("This identity is not registered on the server.");
		}
		await this.applyIdentity(next, signal);
	}

	private async performImportPairedIdentity(
		value: PairedIdentity,
		signal: AbortSignal,
	) {
		this.requireSessionSetup();
		const next = await validateIdentity(value);
		if (next.key.registrationKey !== bytesToB64url(value.public_key)) {
			throw new Error("Invalid paired identity.");
		}
		await this.applyIdentity(next, AbortSignal.any([signal, value.signal]));
	}

	private async performChangeSessionPassword(
		current: string,
		password: string,
		signal: AbortSignal,
	) {
		const before = this.unlockedSession();
		const currentKey = await this.persistence.passwordKey(
			before.saved,
			current,
			signal,
		);
		const identity = await this.openSessionIdentity(
			before.saved,
			currentKey,
			signal,
		);
		const next = await this.persistence.protect(
			before.saved,
			password,
			identity?.identity ?? null,
			signal,
			Boolean(before.saved.key),
		);
		signal.throwIfAborted();
		this.installSession(next.saved, next.key, identity);
	}

	private async performDownloadSessionRecovery(
		password: string,
		signal: AbortSignal,
	) {
		const current = this.sessionIdentity();
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
}
