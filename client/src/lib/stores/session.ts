import { get, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import type { SigningKey } from "../protocol/auth.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import { createChainApi, HttpError } from "../services/library-api.ts";
import {
	createLibraryIdentity,
	type LibraryIdentity,
	type OpenedIdentity,
	openLibraryBackup,
	openLocalIdentity,
	sealEmptyLocalIdentity,
	sealLibraryBackup,
	sealLocalIdentity,
} from "../services/library-identity.ts";
import {
	type Checkpoint,
	clearChainCaches,
	createChainStorage,
} from "../storage/chain.ts";
import {
	createSessionStorage,
	type SavedSession,
	type SessionStorage,
} from "../storage/session.ts";
import { createChain, stateCheckpoint } from "./chain.ts";
export interface LibraryContext {
	readonly serverUrl: string;
	readonly key: SigningKey;
	readonly genesis: Uint8Array<ArrayBuffer>;
	readonly library: Uint8Array<ArrayBuffer>;
	readonly encryption: CryptoKey;
	readonly head: Checkpoint;
	readonly signal: AbortSignal;
}
export interface LibraryBackup {
	readonly bytes: Uint8Array<ArrayBuffer>;
	readonly password: string;
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
	checking: boolean;
	storageError: boolean;
	lockFailed: boolean;
	prepared: boolean;
	pendingConnection: boolean;
	error: string;
	notice: string;
	lastAction: string;
	backup: LibraryBackup | null;
	backupDownloaded: boolean;
}
export interface SessionApi {
	registered(identity: LibraryIdentity, signal: AbortSignal): Promise<boolean>;
	register(
		identity: LibraryIdentity,
		code: string,
		signal: AbortSignal,
	): Promise<void>;
}
interface Options {
	persistence?: SessionStorage;
	http?: SessionApi;
	verify?: (
		identity: LibraryIdentity,
		minimum: Checkpoint,
		signal: AbortSignal,
	) => Promise<Checkpoint>;
	defaultServerUrl?: string;
	download?: (backup: LibraryBackup) => void;
}
export type Session = ReturnType<typeof createSession>;
export function createSession(
	options: Options = {},
): Pick<SessionStoreImpl, keyof SessionStoreImpl> {
	return new SessionStoreImpl(options);
}
class SessionStoreImpl {
	private readonly persistence: SessionStorage;
	private readonly http: SessionApi;
	private readonly verifier: Options["verify"];
	private readonly defaultServer: string;
	private readonly download: (backup: LibraryBackup) => void;
	private readonly state;
	private saved: SavedSession | null = null;
	private wrapping: CryptoKey | null = null;
	private identityOwner: LibraryIdentity | null = null;
	private head: Checkpoint | null = null;
	private lifetime = new AbortController();
	private command: AbortController | null = null;
	private disposed = false;
	private initialLoad?: Promise<boolean>;
	readonly subscribe;
	readonly load = this.loadInitial.bind(this);
	readonly retry = this.readSession.bind(this);
	readonly initialize = this.initializeSession.bind(this);
	readonly unlock = this.unlockSession.bind(this);
	readonly lock = this.lockSession.bind(this);
	readonly changePassword = this.changeLocalPassword.bind(this);
	readonly prepareCreation = this.prepareLibrary.bind(this);
	readonly create = this.registerLibrary.bind(this);
	readonly retryConnection = this.retryIdentity.bind(this);
	readonly restore = this.restoreBackup.bind(this);
	readonly acceptPairing = this.connectIdentity.bind(this);
	readonly prepareBackup = this.prepareLibraryBackup.bind(this);
	readonly downloadBackup = this.downloadLibraryBackup.bind(this);
	readonly copyBackupPassword = this.copyPassword.bind(this);
	readonly forget = this.forgetLibrary.bind(this);
	readonly reset = this.resetClient.bind(this);
	readonly dispose = this.disposeSession.bind(this);
	readonly pairingIdentity = this.sharedIdentity.bind(this);
	constructor({
		persistence = createSessionStorage(),
		http,
		verify,
		defaultServerUrl = globalThis.location?.origin || "http://localhost:8080",
		download = downloadBackup,
	}: Options = {}) {
		this.persistence = persistence;
		this.http = http ?? {
			registered: this.probeRegistration.bind(this),
			register: this.submitRegistration.bind(this),
		};
		this.verifier = verify;
		this.defaultServer = defaultServerUrl;
		this.download = download;
		this.state = writable<SessionState>({
			status: "new",
			serverUrl: defaultServerUrl,
			configured: false,
			unlocked: false,
			busy: false,
			signal: this.lifetime.signal,
			context: null,
			checking: true,
			storageError: false,
			lockFailed: false,
			prepared: false,
			pendingConnection: false,
			error: "",
			notice: "",
			lastAction: "",
			backup: null,
			backupDownloaded: false,
		});
		this.subscribe = this.state.subscribe;
	}
	get ready() {
		return (
			!this.disposed &&
			Boolean(get(this.state).context) &&
			!get(this.state).busy
		);
	}
	private update(patch: Partial<SessionState>) {
		if (!this.disposed) {
			this.state.update((state) => ({ ...state, ...patch }));
		}
	}
	private loadInitial() {
		this.initialLoad ??= this.readSession();
		return this.initialLoad;
	}
	private async action(
		name: string,
		work: (signal: AbortSignal) => Promise<void>,
	) {
		if (this.disposed || this.command) {
			return false;
		}
		const own = new AbortController();
		this.command = own;
		this.update({ busy: true, error: "", lastAction: name });
		try {
			await work(own.signal);
			own.signal.throwIfAborted();
			return true;
		} catch (error) {
			if (!own.signal.aborted) {
				this.update({ error: errorMessage(error) });
			}
			return false;
		} finally {
			if (this.command === own) {
				this.command = null;
				this.update({ busy: false });
			}
		}
	}
	private endIdentity() {
		this.lifetime.abort();
		this.lifetime = new AbortController();
		this.identityOwner?.dispose();
		this.identityOwner = null;
		this.head = null;
		this.clearBackup();
		this.update({
			context: null,
			configured: false,
			prepared: false,
			pendingConnection: false,
			signal: this.lifetime.signal,
		});
	}
	private clearBackup() {
		get(this.state).backup?.bytes.fill(0);
		this.update({ backup: null, backupDownloaded: false });
	}
	private unlocked() {
		if (!this.saved || !this.wrapping) {
			throw new Error("Unlock this client first.");
		}
		return { saved: this.saved, key: this.wrapping };
	}
	private sharedIdentity() {
		if (!this.identityOwner || !this.head || !get(this.state).context) {
			throw new Error("Unlock your library first.");
		}
		return { identity: this.identityOwner, checkpoint: this.head };
	}
	private publishIdentity(active: boolean) {
		const identity = this.identityOwner;
		const context =
			active && identity && this.head
				? Object.freeze({
						serverUrl: identity.origin,
						key: identity.signing,
						genesis: identity.genesis,
						library: identity.library,
						encryption: identity.encryption,
						head: this.head,
						signal: this.lifetime.signal,
					})
				: null;
		this.update({
			status: "unlocked",
			unlocked: true,
			context,
			configured: Boolean(context),
			prepared: Boolean(identity && !active && this.saved?.registrationPending),
			pendingConnection: Boolean(
				identity && !active && !this.saved?.registrationPending,
			),
			serverUrl: identity?.origin ?? this.defaultServer,
			signal: this.lifetime.signal,
		});
	}
	private readSession() {
		return this.action("load", async (signal) => {
			this.update({ checking: true, storageError: false });
			try {
				this.saved = await this.persistence.read(signal);
				signal.throwIfAborted();
				this.update({ status: this.saved ? "locked" : "new", unlocked: false });
			} catch (error) {
				this.update({ storageError: true, status: "locked" });
				throw error;
			} finally {
				this.update({ checking: false });
			}
			if (this.saved?.key) {
				try {
					await this.openSaved(this.saved.key, signal);
				} catch (error) {
					signal.throwIfAborted();
					this.update({
						error: this.wrapping
							? errorMessage(error)
							: "Remembered access could not be restored. Enter your master password.",
					});
				}
			}
		});
	}
	private async openSaved(key: CryptoKey, signal: AbortSignal) {
		if (!this.saved) {
			throw new Error("No saved session.");
		}
		if (
			key.extractable ||
			key.algorithm.name !== "AES-GCM" ||
			!key.usages.includes("encrypt") ||
			!key.usages.includes("decrypt")
		) {
			throw new Error("Invalid unlock key.");
		}
		let opened: OpenedIdentity | null;
		try {
			opened = await openLocalIdentity(this.saved.encrypted, key, signal);
		} catch (error) {
			signal.throwIfAborted();
			throw new Error(
				`Wrong password or damaged saved identity. ${errorMessage(error)}`,
			);
		}
		if (signal.aborted) {
			opened?.identity.dispose();
			signal.throwIfAborted();
		}
		this.endIdentity();
		this.wrapping = key;
		if (opened) {
			this.identityOwner = opened.identity;
			this.head = opened.checkpoint;
			if (!this.saved.registrationPending) {
				try {
					this.head = await this.verifyIdentity(
						opened.identity,
						opened.checkpoint,
						signal,
					);
				} catch (error) {
					this.publishIdentity(false);
					throw error;
				}
			}
		}
		this.publishIdentity(!this.saved.registrationPending);
	}
	private initializeSession(password: string, remember = false) {
		return this.action("initialize", async (signal) => {
			if (!this.saved) {
				this.saved = await this.persistence.read(signal);
			}
			if (this.saved) {
				throw new Error("This client already has a master password.");
			}
			const next = await this.persistence.protect(
				null,
				password,
				(key) => sealEmptyLocalIdentity(key, signal),
				signal,
				remember,
			);
			this.saved = next.saved;
			this.wrapping = next.key;
			this.publishIdentity(false);
		});
	}
	private unlockSession(password: string, remember = false) {
		return this.action("unlock", async (signal) => {
			if (!this.saved) {
				this.saved = await this.persistence.read(signal);
			}
			if (!this.saved) {
				throw new Error("Create a master password first.");
			}
			const key = await this.persistence.passwordKey(
				this.saved,
				password,
				signal,
			);
			await this.openSaved(key, signal);
			this.saved = await this.persistence.remember(
				this.saved,
				remember ? key : null,
				signal,
			);
		});
	}
	private async saveIdentity(
		identity: LibraryIdentity,
		head: Checkpoint,
		pending: boolean,
		signal: AbortSignal,
	) {
		const current = this.unlocked();
		const sealed = await sealLocalIdentity(identity, head, current.key, signal);
		const next = await this.persistence.save(
			current.saved,
			sealed,
			pending,
			signal,
		);
		signal.throwIfAborted();
		if (identity !== this.identityOwner) {
			this.endIdentity();
			this.identityOwner = identity;
		}
		this.head = head;
		this.saved = next;
	}
	private prepareLibrary(server: string) {
		return this.action("prepareCreation", async (signal) => {
			this.unlocked();
			if (this.identityOwner) {
				throw new Error("Forget the current library before creating another.");
			}
			const opened = await createLibraryIdentity(
				new URL(server).origin,
				signal,
			);
			try {
				await this.saveIdentity(
					opened.identity,
					opened.checkpoint,
					true,
					signal,
				);
				this.publishIdentity(false);
				await this.makeBackup(signal);
			} catch (error) {
				if (this.identityOwner !== opened.identity) {
					opened.identity.dispose();
				}
				throw error;
			}
		});
	}
	private registerLibrary({
		serverUrl,
		otc,
	}: {
		serverUrl: string;
		otc: string;
	}) {
		return this.action("create", async (signal) => {
			this.unlocked();
			const identity = this.identityOwner;
			if (
				!identity ||
				!this.head ||
				!this.saved?.registrationPending ||
				identity.origin !== new URL(serverUrl).origin
			) {
				throw new Error("Prepare this library first.");
			}
			if (!(await this.http.registered(identity, signal))) {
				if (!get(this.state).backupDownloaded) {
					throw new Error(
						"Download the library backup and store its generated password securely before registration.",
					);
				}
				await this.http.register(identity, otc, signal);
			}
			const head = await this.verifyIdentity(identity, this.head, signal);
			await this.saveIdentity(identity, head, false, signal);
			this.clearBackup();
			this.publishIdentity(true);
		});
	}
	private async probeRegistration(
		identity: LibraryIdentity,
		signal: AbortSignal,
	) {
		const api = createChainApi(identity.origin, identity.signing, signal);
		try {
			return await api.registered(signal);
		} finally {
			api.dispose();
		}
	}
	private async submitRegistration(
		identity: LibraryIdentity,
		code: string,
		signal: AbortSignal,
	) {
		const api = createChainApi(identity.origin, identity.signing, signal);
		try {
			await api.register(code, identity.genesis, signal);
		} finally {
			api.dispose();
		}
	}
	private async verifyIdentity(
		identity: LibraryIdentity,
		minimum: Checkpoint,
		signal: AbortSignal,
	): Promise<Checkpoint> {
		if (this.verifier) {
			return this.verifier(identity, minimum, signal);
		}
		const api = createChainApi(identity.origin, identity.signing, signal);
		const cache = createChainStorage(
			identity.origin,
			bytesToHex(identity.library),
		);
		const chain = createChain(
			{
				genesis: identity.genesis,
				signing: identity.signing,
				encryption: identity.encryption,
				minimum,
			},
			cache,
			api,
			signal,
		);
		try {
			return stateCheckpoint(await chain.sync());
		} finally {
			chain.dispose();
			api.dispose();
		}
	}
	private async makeBackup(signal: AbortSignal) {
		const identity = this.identityOwner;
		if (!identity || !this.head) {
			throw new Error("No library credentials to back up.");
		}
		let head = this.head;
		if (!this.saved?.registrationPending) {
			const cache = createChainStorage(
				identity.origin,
				bytesToHex(identity.library),
			);
			try {
				const cached = await cache.head(signal);
				if (
					cached &&
					cached.sequence === head.sequence &&
					cached.hash !== head.hash
				) {
					throw new Error("Cached head conflicts with the library checkpoint.");
				}
				if (cached && cached.sequence > head.sequence) {
					head = cached;
				}
			} finally {
				cache.dispose();
			}
		}
		const backup = await sealLibraryBackup(identity, head, signal);
		signal.throwIfAborted();
		this.clearBackup();
		this.update({ backup });
	}
	private prepareLibraryBackup() {
		return this.action("prepareBackup", (signal) => this.makeBackup(signal));
	}
	private downloadLibraryBackup() {
		return this.action("downloadBackup", async (signal) => {
			const file = get(this.state).backup;
			if (!file) {
				throw new Error("Prepare a library backup first.");
			}
			signal.throwIfAborted();
			this.download(file);
			this.update({ backupDownloaded: true });
		});
	}
	private copyPassword() {
		return this.action("copyBackupPassword", async (signal) => {
			const file = get(this.state).backup;
			if (!file) {
				throw new Error("Prepare a library backup first.");
			}
			await navigator.clipboard.writeText(file.password);
			signal.throwIfAborted();
			this.update({
				notice:
					"Backup password copied. Store it securely and separately from the file.",
			});
		});
	}
	private retryIdentity() {
		return this.action("retryConnection", async (signal) => {
			const identity = this.identityOwner;
			if (!identity || !this.head) {
				throw new Error("No library connection to retry.");
			}
			const head = await this.verifyIdentity(identity, this.head, signal);
			await this.saveIdentity(identity, head, false, signal);
			this.publishIdentity(true);
		});
	}
	private restoreBackup(file: Blob, password: string) {
		return this.action("restore", async (signal) => {
			this.unlocked();
			if (this.identityOwner) {
				throw new Error("Forget this library before restoring another.");
			}
			if (file.size > 1024 * 1024) {
				throw new Error("Library backup is too large.");
			}
			const encrypted = new Uint8Array(await file.arrayBuffer());
			let opened: OpenedIdentity;
			try {
				opened = await openLibraryBackup(encrypted, password, signal);
			} finally {
				encrypted.fill(0);
			}
			try {
				await this.installReceived(opened, signal);
			} catch (error) {
				signal.throwIfAborted();
				if (
					!(error instanceof HttpError) ||
					error.status !== 401 ||
					opened.checkpoint.sequence !== 0 ||
					this.identityOwner !== opened.identity
				) {
					throw error;
				}
				await this.saveIdentity(
					opened.identity,
					opened.checkpoint,
					true,
					signal,
				);
				this.publishIdentity(false);
				await this.makeBackup(signal);
				this.update({
					notice:
						"This library has not been registered. Save a backup, then enter an invitation code to finish creation.",
				});
			}
		});
	}
	private connectIdentity(opened: OpenedIdentity, caller: AbortSignal) {
		if (this.disposed || this.command) {
			opened.identity.dispose();
			return Promise.resolve(false);
		}
		return this.action("connect", async (own) => {
			await this.installReceived(opened, AbortSignal.any([own, caller]));
		});
	}
	private async installReceived(opened: OpenedIdentity, signal: AbortSignal) {
		try {
			this.unlocked();
			if (this.identityOwner) {
				throw new Error("Forget this library before connecting another.");
			}
			await this.saveIdentity(
				opened.identity,
				opened.checkpoint,
				false,
				signal,
			);
			this.publishIdentity(false);
			this.head = await this.verifyIdentity(
				opened.identity,
				opened.checkpoint,
				signal,
			);
			await this.saveIdentity(opened.identity, this.head, false, signal);
			this.publishIdentity(true);
		} catch (error) {
			if (this.identityOwner !== opened.identity) {
				opened.identity.dispose();
			}
			throw error;
		}
	}
	private changeLocalPassword(
		oldPassword: string,
		password: string,
		confirmation?: string,
	) {
		return this.action("changePassword", async (signal) => {
			if (confirmation !== undefined && confirmation !== password) {
				throw new Error("Passwords do not match.");
			}
			const current = this.unlocked();
			const old = await this.persistence.passwordKey(
				current.saved,
				oldPassword,
				signal,
			);
			const check = await openLocalIdentity(
				current.saved.encrypted,
				old,
				signal,
			);
			check?.identity.dispose();
			const identity = this.identityOwner;
			const head = this.head;
			const next = await this.persistence.protect(
				current.saved,
				password,
				(key) =>
					identity && head
						? sealLocalIdentity(identity, head, key, signal)
						: sealEmptyLocalIdentity(key, signal),
				signal,
				Boolean(current.saved.key),
				current.saved.registrationPending,
			);
			this.saved = next.saved;
			this.wrapping = next.key;
			this.update({ notice: "Master password changed." });
		});
	}
	private async lockSession() {
		if (this.disposed) {
			return false;
		}
		this.command?.abort();
		this.command = null;
		this.endIdentity();
		this.wrapping = null;
		this.update({
			unlocked: false,
			status: this.saved ? "locked" : "new",
			busy: false,
		});
		try {
			this.saved = await this.persistence.lock(new AbortController().signal);
			this.update({ lockFailed: false });
			return true;
		} catch (error) {
			this.update({ lockFailed: true, error: errorMessage(error) });
			return false;
		}
	}
	private forgetLibrary() {
		return this.action("forget", async (signal) => {
			const current = this.unlocked();
			const identity = this.identityOwner;
			this.endIdentity();

			const sealed = await sealEmptyLocalIdentity(current.key, signal);
			this.saved = await this.persistence.save(
				current.saved,
				sealed,
				false,
				signal,
			);
			if (identity) {
				const cache = createChainStorage(
					identity.origin,
					bytesToHex(identity.library),
				);
				try {
					await cache.clear(signal);
				} finally {
					cache.dispose();
				}
			}
			this.publishIdentity(false);
		});
	}
	private resetClient() {
		return this.action("reset", async (signal) => {
			this.endIdentity();
			await this.persistence.reset(signal);
			await clearChainCaches(signal);
			this.saved = null;
			this.wrapping = null;
			this.update({
				status: "new",
				unlocked: false,
				storageError: false,
				lockFailed: false,
			});
		});
	}
	private disposeSession() {
		if (this.disposed) {
			return;
		}
		this.command?.abort();
		this.command = null;
		this.endIdentity();
		this.wrapping = null;
		this.disposed = true;
		this.update({
			status: this.saved ? "locked" : "new",
			unlocked: false,
			busy: false,
		});
		this.persistence.dispose();
	}
}
function downloadBackup(file: LibraryBackup) {
	const url = URL.createObjectURL(
		new Blob([file.bytes], { type: "application/msgpack" }),
	);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = "i2nclip-library-backup.msgpack";
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}
