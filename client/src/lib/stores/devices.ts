import { get, writable } from "svelte/store";
import { type ChainApi, createChainApi } from "../chain-api.ts";
import { type Checkpoint, equalCheckpoint } from "../chain-storage.ts";
import { verifyDevice } from "../device-verification.ts";
import { errorMessage } from "../error.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import { type Bytes, createRecord, verifyRecord } from "../protocol/chain.ts";
import type { DeviceMembership } from "../protocol/chain-state.ts";
import {
	decodeDevice,
	encodeDevice,
	type LoadedDevice,
} from "../protocol/device.ts";
import { generatePrivateKey } from "../protocol/identity.ts";
import { epochKey, openRecoveryFile } from "../protocol/recovery-key.ts";
import { type ChainStore, stateCheckpoint } from "./chain.ts";
import type { Session } from "./identity.ts";

interface AdmissionProbe {
	registered(signal: AbortSignal): Promise<boolean>;
	dispose(): void;
}
export interface DeviceServices {
	readonly verify?: typeof verifyDevice;
	readonly admission?: (
		device: LoadedDevice,
		signal: AbortSignal,
	) => AdmissionProbe;
}
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
	services: DeviceServices = {},
): Pick<DevicesImpl, keyof DevicesImpl> {
	return new DevicesImpl(session, chain, api, signal, services);
}
class DevicesImpl {
	private readonly session: Session;
	private readonly chain: ChainStore;
	private readonly api: Pick<ChainApi, "append">;
	private readonly verify: typeof verifyDevice;
	private readonly admission: (
		device: LoadedDevice,
		signal: AbortSignal,
	) => AdmissionProbe;
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
		{
			verify = verifyDevice,
			admission = (device, signal) =>
				createChainApi(device.identity.serverUrl, device.key, signal),
		}: DeviceServices,
	) {
		this.session = session;
		this.chain = chain;
		this.api = api;
		this.verify = verify;
		this.admission = admission;
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
			effects: [publicKey],
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
				const { privateKey } = await generatePrivateKey();
				const salt = crypto.getRandomValues(new Uint8Array(32));
				const secret = await epochKey(
					recovery.identity.epochDerivationSecret,
					state.library,
					state.epoch + 1,
					salt,
				);
				try {
					const record = await createRecord(
						{
							library: state.library,
							sequence: state.sequence + 1,
							previous: state.head,
							epoch: state.epoch,
							signer: recovery.key.publicKey,
							kind: "rotate",
							effects: [state.epoch + 1, privateKey.public_key, salt],
						},
						recovery.key.privateCryptoKey,
					);
					this.signal.throwIfAborted();
					if (
						!(await this.session.prepareRotation(
							{ replacement: privateKey, secret, record: record.bytes },
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
					privateKey.seed.fill(0);
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
			if (!equalCheckpoint(stateCheckpoint(state), current.identity.head)) {
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
					status: `Submission outcome is uncertain: ${errorMessage(error)} Checking the replacement device…`,
				});
			}
			await this.reconcilePending();
		});
	}
	private reconcileEpoch() {
		return this.action(() => this.reconcilePending());
	}
	private async authorized(device: LoadedDevice) {
		const probe = this.admission(device, this.signal);
		try {
			return await probe.registered(this.signal);
		} finally {
			probe.dispose();
		}
	}
	private async reconcilePending() {
		const current = this.session.device();
		const pending = current.identity.rotation;
		if (!pending) {
			throw new Error("No pending rotation to reconcile.");
		}
		const record = await verifyRecord(pending.record);
		const accepted = {
			sequence: record.body.sequence,
			hash: bytesToHex(record.hash),
		};
		const replacement = await decodeDevice(
			encodeDevice({
				...current.identity,
				privateKey: pending.replacement,
				epochs: [
					...current.identity.epochs,
					[current.identity.epochs.length + 1, pending.secret],
				],
				head: accepted,
				rotation: null,
			}),
		);
		// Probe the replacement first: acceptance has already revoked the old signer.
		if (await this.authorized(replacement)) {
			const verified = await this.verify(replacement, accepted, this.signal);
			if (!(await this.session.finishRotation(verified))) {
				throw new Error(
					get(this.session).error ||
						"Could not save the verified rotation outcome.",
				);
			}
			this.update({
				status:
					"Epoch rotated. Every other device must re-pair. Replacement credentials are saved locally.",
			});
			return;
		}
		if (!(await this.authorized(current))) {
			throw new Error(
				"Neither saved device is authorized. Another rotation may have revoked both; re-pair with an active device.",
			);
		}
		const verified = await this.verify(
			current,
			current.identity.head,
			this.signal,
		);
		if (!equalCheckpoint(stateCheckpoint(verified), current.identity.head)) {
			throw new Error(
				"The library advanced without this rotation. Prepare a new rotation.",
			);
		}
		this.update({
			status:
				"The saved rotation has not been accepted. Its credentials are preserved; you can retry the exact transition.",
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
