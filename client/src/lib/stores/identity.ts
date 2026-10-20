import { get, type Writable, writable } from "svelte/store";
import { createChainApi } from "../chain-api.ts";
import { createChainStorage } from "../chain-storage.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { createPersistence, type SavedIdentity } from "../persistence.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import type { SigningKey } from "../protocol/crypto.ts";
import {
	createDevice,
	type DeviceIdentity,
	decodeDevice,
	encodeDevice,
	exportDeviceBackup,
	type LoadedDevice,
	MAX_DEVICE_BACKUP_BYTES,
	openDeviceBackup,
} from "../protocol/device.ts";
import { decode, encode } from "../protocol/msgpack.ts";
import { checkServer } from "../protocol/server.ts";

// A library consumer never observes changing credentials.
export interface LibraryContext {
	readonly serverUrl: string;
	readonly key: SigningKey;
	readonly identity: DeviceIdentity;
	readonly initialPublicKey: Uint8Array<ArrayBuffer>;
	readonly signal: AbortSignal;
}
export interface IdentityApi {
	registered(device: LoadedDevice, signal: AbortSignal): Promise<boolean>;
	register(
		device: LoadedDevice,
		code: string,
		signal: AbortSignal,
	): Promise<void>;
}
const httpApi: IdentityApi = {
	async registered(device, signal) {
		const api = createChainApi(device.identity.serverUrl, device.key, signal);
		try {
			return await api.registered(signal);
		} finally {
			api.dispose();
		}
	},
	async register(device, code, signal) {
		const api = createChainApi(device.identity.serverUrl, device.key, signal);
		try {
			await api.register(code, signal);
		} finally {
			api.dispose();
		}
	},
};

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
	prepared: boolean;
	lockFailed: boolean;
	notice: string;
}

export interface IdentityCredentials {
	serverUrl: string;
	key: SigningKey;
	privateKey: DeviceIdentity["privateKey"];
	publicKey: string;
	device: DeviceIdentity;
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
	private library: LoadedDevice | null;
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
	readonly changePassword = this.changeSessionPassword.bind(this);
	readonly forget = this.forgetIdentity.bind(this);
	readonly reset = this.resetSession.bind(this);
	readonly downloadRecovery = this.downloadSessionRecovery.bind(this);
	readonly dispose = this.disposeSession.bind(this);

	constructor({
		persistence = createPersistence(),
		http = httpApi,
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
			prepared: false,
			lockFailed: false,
			notice: "",
		});
		this.subscribe = this.state.subscribe;
		this.saved = null;
		this.key = null;
		this.library = null;
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
	}

	private installSession(
		next: SavedIdentity,
		wrapping: CryptoKey,
		identity: LoadedDevice | null,
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
		const context =
			identity?.identity.phase === "active"
				? Object.freeze({
						serverUrl: identity.identity.serverUrl,
						key: identity.key,
						identity: identity.identity,
						initialPublicKey: identity.initialPublicKey,
						signal: this.lifetime.signal,
					})
				: null;
		this.publishSession({
			status: "unlocked",
			unlocked: true,
			configured: Boolean(context),
			prepared: Boolean(identity && identity.identity.phase !== "active"),
			context,
			signal: this.lifetime.signal,
			serverUrl: identity?.identity.serverUrl || this.defaultServerUrl,
			error: "",
			lockFailed: false,
		});
	}

	private lockedState() {
		this.publishSession({
			status: this.saved ? "locked" : "new",
			unlocked: false,
			configured: false,
			prepared: false,
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
		const identity = value ? await decodeDevice(encode(value)) : null;
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
		identity: LoadedDevice | null,
		signal: AbortSignal,
	) {
		const current = this.unlockedSession();
		const next = await this.persistence.save(
			current.saved,
			current.key,
			identity ? decode(encodeDevice(identity.identity)) : null,
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
		if (this.library?.identity.phase !== "active" || this.disposed) {
			throw new Error("Unlock your library first.");
		}
		return {
			serverUrl: this.library.identity.serverUrl,
			key: this.library.key,
			privateKey: this.library.identity.privateKey,
			publicKey: this.library.key.registrationKey,
			device: this.library.identity,
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
		identity: LoadedDevice | null,
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
		{ serverUrl, otc }: { serverUrl: string; otc: string },
		signal: AbortSignal,
	) {
		this.unlockedSession();
		checkServer(serverUrl);
		const origin = new URL(serverUrl).origin;
		let next = this.library;
		if (
			next &&
			(next.identity.phase !== "registering" ||
				next.identity.serverUrl !== origin)
		) {
			throw new Error("Forget the prepared library before creating another.");
		}
		if (!next) {
			next = await createDevice(origin);
			signal.throwIfAborted();
			// Persist both independent secrets before the first request can succeed.
			await this.applyIdentity(next, signal);
		}
		try {
			if (!(await this.http.registered(next, signal))) {
				await this.http.register(next, otc, signal);
			}
			signal.throwIfAborted();
			await this.applyIdentity(
				{ ...next, identity: { ...next.identity, phase: "active" } },
				signal,
			);
		} catch (error) {
			signal.throwIfAborted();
			throw new Error(
				`${errorMessage(error)} The prepared credentials are saved. Retry Create after reopening or unlocking this client.`,
			);
		}
	}

	private async performRestoreIdentity(
		file: Blob,
		password: string,
		signal: AbortSignal,
	) {
		this.requireSessionSetup();
		if (file.size > MAX_DEVICE_BACKUP_BYTES) {
			throw new Error("Recovery file is too large.");
		}
		const next = await openDeviceBackup(
			new Uint8Array(await file.arrayBuffer()),
			password,
		);
		signal.throwIfAborted();
		if (!(await this.http.registered(next, signal))) {
			throw new Error(
				"This device is not authorized. Re-pair it with an active device.",
			);
		}
		await this.applyIdentity(next, signal);
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
			identity ? decode(encodeDevice(identity.identity)) : null,
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
		const cache = createChainStorage(
			current.serverUrl,
			bytesToHex(current.device.library),
		);
		let identity = current.device;
		try {
			const head = await cache.head(signal);
			if (head && head.sequence >= identity.head.sequence) {
				identity = { ...identity, head };
			}
		} finally {
			cache.dispose();
		}
		const bytes = await exportDeviceBackup(identity, password);
		signal.throwIfAborted();
		const url = URL.createObjectURL(
			new Blob([bytes], { type: "application/msgpack" }),
		);
		try {
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "i2nclip-device-backup.msgpack";
			anchor.click();
		} finally {
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		}
	}
}
