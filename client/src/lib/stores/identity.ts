import { get, type Writable, writable } from "svelte/store";
import { createChainApi } from "../chain-api.ts";
import type { Checkpoint } from "../chain-storage.ts";
import { verifyDevice } from "../device-verification.ts";
import { errorMessage } from "../error.ts";
import { prepareRecoveryDevice } from "../library-recovery.ts";
import { createLog, failureFields } from "../log.ts";
import { createPersistence, type SavedIdentity } from "../persistence.ts";
import {
	createRecoveryFile,
	type EncryptedBackup,
} from "../protocol/backup.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import type { ChainState } from "../protocol/chain-state.ts";
import type { SigningKey } from "../protocol/crypto.ts";
import {
	createLibraryDevice,
	type DeviceIdentity,
	decodeDevice,
	encodeDevice,
	type LoadedDevice,
	type PendingRotation,
	rotationReplacement,
} from "../protocol/device.ts";
import { decode, encode } from "../protocol/msgpack.ts";
import {
	epochKey,
	type LoadedRecovery,
	openRecoveryFile,
	parseRecoveryGenesis,
} from "../protocol/recovery-key.ts";
import { checkServer } from "../protocol/server.ts";
import { stateCheckpoint } from "./chain.ts";

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
			const genesis = await parseRecoveryGenesis(device.identity.genesis);
			await api.register(
				code,
				genesis.recoveryPublicKey,
				genesis.epochSalt,
				signal,
			);
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
	recoveryFile: EncryptedBackup | null;
	recoveryDownloaded: boolean;
	status: "new" | "locked" | "unlocked";
	serverUrl: string;
	context: LibraryContext | null;
	error: string;
	checking: boolean;
	storageError: boolean;
	prepared: boolean;
	pendingRotation: boolean;
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
		verify?: typeof verifyDevice;
		defaultServerUrl?: string;
		download?: (file: EncryptedBackup) => void;
	} = {},
): Pick<SessionStoreImpl, keyof SessionStoreImpl> {
	return new SessionStoreImpl(options);
}

class SessionStoreImpl {
	private readonly persistence: ReturnType<typeof createPersistence>;
	private readonly http: IdentityApi;
	private readonly verify: typeof verifyDevice;
	private readonly defaultServerUrl: string;
	private readonly download: (file: EncryptedBackup) => void;
	private creationRecovery: LoadedRecovery | null = null;
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
	readonly device = this.loadedDevice.bind(this);
	readonly preparePairing = this.preparePairedDevice.bind(this);
	readonly activatePairing = this.activatePairedDevice.bind(this);
	readonly prepareRotation = this.savePendingRotation.bind(this);
	readonly finishRotation = this.installRotatedDevice.bind(this);
	readonly initialize = this.initializeSession.bind(this);
	readonly unlock = this.unlockSession.bind(this);
	readonly create = this.createIdentity.bind(this);
	readonly prepareCreation = this.prepareNewLibrary.bind(this);
	readonly resumeCreation = this.resumeNewLibrary.bind(this);
	readonly restore = this.restoreLibrary.bind(this);
	readonly submitRecovery = this.submitLibraryRecovery.bind(this);
	readonly reconcileRecovery = this.reconcileLibraryRecovery.bind(this);
	readonly downloadRecovery = this.downloadCreationRecovery.bind(this);
	readonly changePassword = this.changeSessionPassword.bind(this);
	readonly forget = this.forgetIdentity.bind(this);
	readonly reset = this.resetSession.bind(this);
	readonly dispose = this.disposeSession.bind(this);

	constructor({
		persistence = createPersistence(),
		http = httpApi,
		verify = verifyDevice,
		defaultServerUrl = globalThis.location?.origin || "http://localhost:8080",
		download = downloadRecoveryFile,
	}: {
		persistence?: ReturnType<typeof createPersistence>;
		http?: IdentityApi;
		verify?: typeof verifyDevice;
		defaultServerUrl?: string;
		download?: (file: EncryptedBackup) => void;
	} = {}) {
		this.persistence = persistence;
		this.http = http;
		this.verify = verify;
		this.defaultServerUrl = defaultServerUrl;
		this.download = download;
		this.log = createLog("session");
		const lifetime = new AbortController();
		this.state = writable<SessionState>({
			status: "new",
			recoveryFile: null,
			recoveryDownloaded: false,
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
			pendingRotation: false,
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
		this.clearCreationRecovery();
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
			pendingRotation: Boolean(identity?.identity.rotation),
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
			pendingRotation: false,
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

	private loadedDevice(): LoadedDevice {
		this.unlockedSession();
		if (!this.library || this.disposed) {
			throw new Error("No prepared device credentials.");
		}
		return this.library;
	}

	private preparePairedDevice(identity: DeviceIdentity, caller: AbortSignal) {
		return this.sessionAction("preparePairing", async (own) => {
			const signal = AbortSignal.any([own, caller]);
			this.unlockedSession();
			const next = await decodeDevice(encodeDevice(identity));
			if (identity.phase !== "pairing" || identity.rotation) {
				throw new Error("Invalid pairing preparation.");
			}
			if (
				this.library &&
				(this.library.identity.phase !== "pairing" ||
					this.library.key.registrationKey !== next.key.registrationKey ||
					bytesToHex(this.library.identity.library) !==
						bytesToHex(identity.library))
			) {
				throw new Error("Forget the current device before pairing another.");
			}
			await this.applyIdentity(next, signal);
		});
	}

	private activatePairedDevice(minimum?: Checkpoint, caller?: AbortSignal) {
		return this.sessionAction("activatePairing", async (own) => {
			const signal = caller ? AbortSignal.any([own, caller]) : own;
			const prepared = this.loadedDevice();
			if (prepared.identity.phase !== "pairing") {
				throw new Error("No pairing is awaiting enrollment.");
			}
			const pinned = minimum ?? prepared.identity.head;
			if (
				pinned.sequence < prepared.identity.head.sequence ||
				(pinned.sequence === prepared.identity.head.sequence &&
					pinned.hash !== prepared.identity.head.hash)
			) {
				throw new Error("Pairing completion conflicts with its trusted head.");
			}
			const verified = await this.verify(prepared, pinned, signal);
			await this.applyIdentity(
				{
					...prepared,
					identity: {
						...prepared.identity,
						head: stateCheckpoint(verified),
						phase: "active",
					},
				},
				signal,
			);
		});
	}

	private savePendingRotation(rotation: PendingRotation, head: Checkpoint) {
		return this.sessionAction("prepareRotation", async (signal) => {
			const current = this.loadedDevice();
			if (current.identity.phase !== "active") {
				throw new Error("Only an active device can rotate the library.");
			}
			const next = await decodeDevice(
				encodeDevice({ ...current.identity, head, rotation }),
			);
			const unlocked = this.unlockedSession();
			const saved = await this.persistence.save(
				unlocked.saved,
				unlocked.key,
				decode(encodeDevice(next.identity)),
				signal,
			);
			signal.throwIfAborted();
			// Preparing a transition changes protected credentials, not the active signer.
			// Preserve its context until acceptance; the pending flag blocks UI writes.
			this.saved = saved;
			this.library = next;
			this.publishSession({ pendingRotation: true });
		});
	}

	private installRotatedDevice(verified: ChainState) {
		return this.sessionAction("finishRotation", async (signal) => {
			const current = this.loadedDevice();
			const pending = current.identity.rotation;
			if (
				!pending ||
				verified.epoch !== current.identity.epochs.length + 1 ||
				verified.sequence <= current.identity.head.sequence ||
				bytesToHex(verified.library) !== bytesToHex(current.identity.library) ||
				verified.devices.get(bytesToHex(pending.replacement.public_key))
					?.revokedAt !== null
			) {
				throw new Error(
					"Rotation has not been verified for the replacement device.",
				);
			}
			const next = await decodeDevice(
				encodeDevice({
					...current.identity,
					privateKey: pending.replacement,
					epochs: [
						...current.identity.epochs,
						[verified.epoch, pending.secret],
					],
					head: stateCheckpoint(verified),
					rotation: null,
					phase: "active",
				}),
			);
			await this.applyIdentity(next, signal);
			this.publishSession({
				notice:
					"Epoch rotated. Every other device must re-pair. Replacement credentials are saved locally.",
			});
		});
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

	private clearCreationRecovery() {
		this.creationRecovery?.identity.signingKey.seed.fill(0);
		this.creationRecovery?.identity.epochDerivationSecret.fill(0);
		this.creationRecovery = null;
		const artifact = get(this.state).recoveryFile;
		artifact?.bytes.fill(0);
		this.publishSession({ recoveryFile: null, recoveryDownloaded: false });
	}
	private prepareNewLibrary(serverUrl: string) {
		return this.sessionAction("prepareCreation", (signal) =>
			this.prepareLibrary(serverUrl, signal),
		);
	}
	private async prepareLibrary(serverUrl: string, signal: AbortSignal) {
		this.unlockedSession();
		checkServer(serverUrl);
		if (this.library) {
			throw new Error("Forget the prepared library before creating another.");
		}
		const created = await createLibraryDevice(new URL(serverUrl).origin);
		try {
			signal.throwIfAborted();
			const artifact = await createRecoveryFile(created.recovery.identity);
			signal.throwIfAborted();
			await this.applyIdentity(created.device, signal);
			this.creationRecovery = created.recovery;
			this.publishSession({
				recoveryFile: artifact,
				recoveryDownloaded: false,
			});
		} catch (error) {
			created.recovery.identity.signingKey.seed.fill(0);
			created.recovery.identity.epochDerivationSecret.fill(0);
			throw error;
		}
	}
	private downloadCreationRecovery() {
		return this.sessionAction("downloadRecovery", async (signal) => {
			const artifact = get(this.state).recoveryFile;
			if (!artifact || !this.creationRecovery) {
				throw new Error(
					"Import the matching recovery file or prepare a new library.",
				);
			}
			signal.throwIfAborted();
			this.download(artifact);
			signal.throwIfAborted();
			this.publishSession({ recoveryDownloaded: true });
		});
	}
	private resumeNewLibrary(file: Blob, password: string) {
		return this.sessionAction("resumeCreation", async (signal) => {
			this.unlockedSession();
			if (this.library?.identity.phase !== "registering") {
				throw new Error("No pending library creation.");
			}
			if (file.size > 1024 * 1024) {
				throw new Error("Recovery file is too large.");
			}
			const recovery = await openRecoveryFile(
				new Uint8Array(await file.arrayBuffer()),
				password,
			);
			try {
				signal.throwIfAborted();
				if (
					bytesToHex(recovery.genesis.hash) !==
					bytesToHex(this.library.identity.library)
				) {
					throw new Error("Recovery file belongs to another library.");
				}
				const first = await epochKey(
					recovery.identity.epochDerivationSecret,
					recovery.genesis.hash,
					1,
					recovery.genesis.epochSalt,
				);
				try {
					if (
						bytesToHex(first) !== bytesToHex(this.library.identity.epochs[0][1])
					) {
						throw new Error(
							"Recovery epoch key does not match the prepared library.",
						);
					}
				} finally {
					first.fill(0);
				}

				this.clearCreationRecovery();
				this.creationRecovery = recovery;
				// Import demonstrates that this file exists outside transient creation memory.
				this.publishSession({ recoveryDownloaded: true });
			} catch (error) {
				recovery.identity.signingKey.seed.fill(0);
				recovery.identity.epochDerivationSecret.fill(0);
				throw error;
			}
		});
	}
	private async performCreateIdentity(
		{ serverUrl, otc }: { serverUrl: string; otc: string },
		signal: AbortSignal,
	) {
		this.unlockedSession();
		checkServer(serverUrl);
		const origin = new URL(serverUrl).origin;
		if (!this.library) {
			await this.prepareLibrary(origin, signal);
		}
		const next = this.loadedDevice();
		if (
			next.identity.phase !== "registering" ||
			next.identity.serverUrl !== origin
		) {
			throw new Error("Forget the prepared library before creating another.");
		}
		try {
			if (!(await this.http.registered(next, signal))) {
				if (!get(this.state).recoveryDownloaded) {
					throw new Error(
						"Download the recovery file and store its generated password securely before registration. After a restart, import the matching recovery file.",
					);
				}
				await this.http.register(next, otc, signal);
			}
			signal.throwIfAborted();
			await this.applyIdentity(
				{ ...next, identity: { ...next.identity, phase: "active" } },
				signal,
			);
			this.clearCreationRecovery();
		} catch (error) {
			signal.throwIfAborted();
			throw new Error(
				`${errorMessage(error)} The prepared credentials are saved. Retry Create after reopening or unlocking this client.`,
			);
		}
	}

	private restoreLibrary(file: Blob, password: string) {
		return this.sessionAction("restore", async (signal) => {
			this.unlockedSession();
			if (this.library && this.library.identity.phase !== "resetting") {
				throw new Error("Forget the current library before recovery.");
			}
			if (file.size > 1024 * 1024) {
				throw new Error("Recovery file is too large.");
			}
			const recovery = await openRecoveryFile(
				new Uint8Array(await file.arrayBuffer()),
				password,
			);
			try {
				signal.throwIfAborted();
				if (
					this.library &&
					bytesToHex(this.library.identity.library) !==
						bytesToHex(recovery.genesis.hash)
				) {
					throw new Error("Recovery file belongs to another library.");
				}
				const candidate = await prepareRecoveryDevice(recovery, signal);
				signal.throwIfAborted();
				await this.applyIdentity(candidate, signal);
				this.publishSession({
					notice:
						"History verified. The recovery-approved reset is saved locally and ready to submit.",
				});
			} finally {
				recovery.identity.signingKey.seed.fill(0);
				recovery.identity.epochDerivationSecret.fill(0);
			}
		});
	}
	private recoveryCandidate() {
		const current = this.loadedDevice();
		if (current.identity.phase !== "resetting" || !current.identity.rotation) {
			throw new Error("No pending library recovery.");
		}
		return current;
	}
	private submitLibraryRecovery() {
		return this.sessionAction("submitRecovery", async (signal) => {
			const current = this.recoveryCandidate();
			const pending = current.identity.rotation;
			if (!pending) {
				throw new Error("No pending recovery reset.");
			}
			const replacement = await rotationReplacement(current);
			const api = createChainApi(
				current.identity.serverUrl,
				current.key,
				signal,
			);
			try {
				if (await api.registered(signal)) {
					await this.activateRecoveredDevice(replacement, signal);
					return;
				}
				let failure: unknown;
				try {
					const receipt = await api.append(pending.record, signal);
					if (
						receipt.accepted.hash !== replacement.identity.head.hash ||
						receipt.accepted.sequence !== replacement.identity.head.sequence
					) {
						throw new Error("Server acknowledged a different reset.");
					}
				} catch (error) {
					signal.throwIfAborted();
					failure = error;
				}
				if (!(await api.registered(signal))) {
					throw new Error(
						`${failure ? errorMessage(failure) : "Reset acceptance is not verified."} The local pending plan is preserved. Retry the exact reset, or restore the recovery file again if the parent changed.`,
					);
				}
				await this.activateRecoveredDevice(replacement, signal);
			} finally {
				api.dispose();
			}
		});
	}
	private reconcileLibraryRecovery() {
		return this.sessionAction("reconcileRecovery", async (signal) => {
			const current = this.recoveryCandidate();
			const pending = current.identity.rotation;
			if (!pending) {
				throw new Error("No pending recovery reset.");
			}
			const replacement = await rotationReplacement(current);
			const api = createChainApi(
				current.identity.serverUrl,
				current.key,
				signal,
			);
			try {
				if (!(await api.registered(signal))) {
					throw new Error(
						"The saved candidate is not authorized. Retry the exact reset or restore the recovery file to prepare against the current head.",
					);
				}
				await this.activateRecoveredDevice(replacement, signal);
			} finally {
				api.dispose();
			}
		});
	}
	private async activateRecoveredDevice(
		replacement: LoadedDevice,
		signal: AbortSignal,
	) {
		const state = await this.verify(
			replacement,
			replacement.identity.head,
			signal,
		);
		await this.applyIdentity(
			{
				...replacement,
				identity: { ...replacement.identity, head: stateCheckpoint(state) },
			},
			signal,
		);
		this.publishSession({
			notice: "Recovery complete. Every other device must re-pair.",
		});
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
}

function downloadRecoveryFile(file: EncryptedBackup) {
	const url = URL.createObjectURL(
		new Blob([file.bytes], { type: "application/msgpack" }),
	);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "i2nclip-library-recovery.msgpack";
		anchor.click();
	} finally {
		URL.revokeObjectURL(url);
	}
}
