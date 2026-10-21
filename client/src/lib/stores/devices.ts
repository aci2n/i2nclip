import { get, writable } from "svelte/store";
import type { ChainApi } from "../chain-api.ts";
import type { Checkpoint } from "../chain-storage.ts";
import { errorMessage } from "../error.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import { type Bytes, createRecord, verifyRecord } from "../protocol/chain.ts";
import type { DeviceMembership } from "../protocol/chain-state.ts";
import { sealEpochKeys } from "../protocol/epoch-envelope.ts";
import { epochKey, openRecoveryFile } from "../protocol/recovery-key.ts";
import { type ChainStore, stateCheckpoint } from "./chain.ts";
import type { Session } from "./identity.ts";

export interface DevicesState {
	readonly members: readonly DeviceMembership[];
	readonly busy: boolean;
	readonly error: string;
	readonly status: string;
	readonly rotationPrepared: boolean;
}
export type Devices = ReturnType<typeof createDevices>;
export function createDevices(
	session: Session,
	chain: ChainStore,
	api: Pick<ChainApi, "append">,
	signal: AbortSignal,
): Pick<DevicesImpl, keyof DevicesImpl> {
	return new DevicesImpl(session, chain, api, signal);
}
class DevicesImpl {
	private readonly session: Session;
	private readonly chain: ChainStore;
	private readonly api: Pick<ChainApi, "append">;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private readonly state = writable<DevicesState>({
		members: [],
		busy: false,
		error: "",
		status: "",
		rotationPrepared: false,
	});
	private readonly subscriptions: Array<() => void> = [];
	private busy = false;
	private disposed = false;
	readonly subscribe = this.state.subscribe;
	readonly enroll = this.enrollDevice.bind(this);
	readonly revoke = this.revokeDevice.bind(this);
	readonly prepareRotation = this.prepareEpoch.bind(this);
	readonly submitRotation = this.submitEpoch.bind(this);
	readonly reconcile = this.reconcileEpoch.bind(this);
	readonly dispose = this.disposeDevices.bind(this);
	constructor(
		session: Session,
		chain: ChainStore,
		api: Pick<ChainApi, "append">,
		signal: AbortSignal,
	) {
		this.session = session;
		this.chain = chain;
		this.api = api;
		this.signal = AbortSignal.any([signal, this.controller.signal]);
		this.subscriptions.push(
			chain.subscribe((view) => {
				if (!this.disposed) {
					this.state.update((state) => ({
						...state,
						members: [...(view.live?.devices.values() ?? [])].sort(
							(a, b) => a.authorizedAt - b.authorizedAt,
						),
					}));
				}
			}),
		);
		this.subscriptions.push(
			session.subscribe((view) => {
				if (!this.disposed) {
					this.state.update((state) => ({
						...state,
						rotationPrepared: view.pendingRotation,
					}));
				}
			}),
		);
		this.signal.addEventListener("abort", this.dispose, { once: true });
	}
	private update(patch: Partial<DevicesState>) {
		if (!this.disposed) {
			this.state.update((state) => ({ ...state, ...patch }));
		}
	}
	private async action(work: () => Promise<void>) {
		if (this.disposed || this.signal.aborted || this.busy) {
			return false;
		}
		this.busy = true;
		this.update({ busy: true, error: "", status: "" });
		try {
			await work();
			return true;
		} catch (error) {
			if (!this.signal.aborted) {
				this.update({ error: errorMessage(error) });
			}
			return false;
		} finally {
			this.busy = false;
			this.update({ busy: false });
		}
	}
	private requireWritable() {
		this.signal.throwIfAborted();
		if (get(this.session).pendingRotation) {
			throw new Error(
				"Finish the pending epoch rotation before publishing other changes.",
			);
		}
	}
	private async enrollDevice(
		publicKey: Bytes,
		encryptionPublicKey: Bytes,
		expected: Checkpoint,
		caller: AbortSignal,
	) {
		this.requireWritable();
		if (this.busy) {
			throw new Error("Another device operation is already in progress.");
		}
		const signal = AbortSignal.any([this.signal, caller]);
		const state = await this.chain.append({
			expected,
			kind: "enroll",
			effects: [publicKey, encryptionPublicKey],
			signal,
		});
		return stateCheckpoint(state);
	}
	private revokeDevice(publicKey: Bytes, expected: Checkpoint) {
		return this.action(async () => {
			this.requireWritable();
			await this.chain.append({
				expected,
				kind: "revoke",
				effects: [publicKey],
				signal: this.signal,
			});
			this.update({
				status:
					"Device revoked. Rotate the epoch to exclude it from future encryption secrets.",
			});
		});
	}
	private prepareEpoch(file: Blob, password: string) {
		return this.action(async () => {
			const state = await this.chain.sync();
			this.signal.throwIfAborted();
			const current = this.session.device();
			if (
				state.devices.get(bytesToHex(current.key.publicKey))?.revokedAt !== null
			) {
				throw new Error("This device no longer has rotation authority.");
			}
			if (file.size > 1024 * 1024) {
				throw new Error("Recovery file is too large.");
			}
			const recovery = await openRecoveryFile(
				new Uint8Array(await file.arrayBuffer()),
				password,
			);
			try {
				this.signal.throwIfAborted();
				if (bytesToHex(recovery.genesis.hash) !== bytesToHex(state.library)) {
					throw new Error("Recovery file belongs to another library.");
				}
				const salt = crypto.getRandomValues(new Uint8Array(32));
				const secret = await epochKey(
					recovery.identity.epochDerivationSecret,
					state.library,
					state.epoch + 1,
					salt,
				);
				try {
					const envelopes = await sealEpochKeys(
						{
							library: state.library,
							sequence: state.sequence + 1,
							previous: state.head,
							epoch: state.epoch,
							nextEpoch: state.epoch + 1,
							salt,
						},
						[...state.devices.values()],
						secret,
					);
					const record = await createRecord(
						{
							library: state.library,
							sequence: state.sequence + 1,
							previous: state.head,
							epoch: state.epoch,
							signer: recovery.key.publicKey,
							kind: "rotate",
							effects: [state.epoch + 1, salt, envelopes],
						},
						recovery.key.privateCryptoKey,
					);
					this.signal.throwIfAborted();
					if (
						!(await this.session.prepareRotation(
							{ secret, record: record.bytes },
							stateCheckpoint(state),
						))
					) {
						throw new Error(
							get(this.session).error ||
								"Could not preserve rotation credentials.",
						);
					}
				} finally {
					secret.fill(0);
				}
			} finally {
				recovery.identity.signingKey.seed.fill(0);
				recovery.identity.epochDerivationSecret.fill(0);
			}

			this.update({
				status: "Rotation prepared and saved locally. It can now be submitted.",
			});
		});
	}
	private submitEpoch() {
		return this.action(async () => {
			const current = this.session.device();
			const pending = current.identity.rotation;
			if (!pending) {
				throw new Error("No epoch rotation is prepared.");
			}
			const record = await verifyRecord(pending.record);
			const state = await this.chain.sync();
			this.signal.throwIfAborted();
			if (state.sequence >= record.body.sequence) {
				await this.reconcilePending();
				return;
			}
			if (bytesToHex(state.head) !== bytesToHex(record.body.previous)) {
				throw new Error("The library changed. Prepare a new rotation.");
			}
			try {
				const receipt = await this.api.append(pending.record, this.signal);
				if (
					receipt.accepted.sequence !== record.body.sequence ||
					receipt.accepted.hash !== bytesToHex(record.hash)
				) {
					throw new Error("Server acknowledged a different rotation.");
				}
			} catch (error) {
				this.signal.throwIfAborted();
				this.update({
					status: `Submission outcome is uncertain: ${errorMessage(error)} Checking the exact rotation…`,
				});
			}
			await this.reconcilePending();
		});
	}
	private reconcileEpoch() {
		return this.action(() => this.reconcilePending());
	}
	private async reconcilePending() {
		const current = this.session.device();
		const pending = current.identity.rotation;
		if (!pending) {
			throw new Error("No pending rotation to reconcile.");
		}
		const record = await verifyRecord(pending.record);
		const live = await this.chain.sync();
		if (live.sequence < record.body.sequence) {
			throw new Error(
				"The saved rotation has not been accepted. Its exact plan is preserved for retry.",
			);
		}
		const accepted = await this.chain.at(record.body.sequence, this.signal);
		if (bytesToHex(accepted.head) !== bytesToHex(record.hash)) {
			throw new Error(
				"The library advanced without this rotation. Prepare a new rotation.",
			);
		}
		const epochs = this.chain.keyring();
		try {
			if (!(await this.session.finishRotation(accepted, epochs))) {
				throw new Error(
					get(this.session).error ||
						"Could not save the verified rotation outcome.",
				);
			}
		} finally {
			for (const [, secret] of epochs) {
				secret.fill(0);
			}
		}
		this.update({
			status:
				"Epoch rotated. Authorized devices retain access without re-pairing.",
		});
	}
	private disposeDevices() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.signal.removeEventListener("abort", this.dispose);
		this.controller.abort();
		for (const unsubscribe of this.subscriptions) {
			unsubscribe();
		}
	}
}
