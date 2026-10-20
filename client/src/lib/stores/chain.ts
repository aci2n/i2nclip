import { type Writable, writable } from "svelte/store";
import {
	type CachedBlock,
	type ChainStorage,
	type Checkpoint,
	equalCheckpoint,
} from "../chain-storage.ts";
import { errorMessage } from "../error.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import {
	type BlockKind,
	type Bytes,
	createRecord,
	decryptOperation,
	type Effects,
	MAX_PAGE_BLOCKS,
	MAX_PAGE_BYTES,
	type VerifiedBlock,
	verifyRecord,
} from "../protocol/chain.ts";
import {
	type ChainState,
	initialChainState,
	reduceBlock,
} from "../protocol/chain-state.ts";

export interface ChainPage {
	readonly target: Checkpoint;
	readonly records: readonly Bytes[];
	readonly next: string | null;
}
export interface ChainTransport {
	read(
		after: string,
		until: string | null,
		signal: AbortSignal,
	): Promise<ChainPage>;
	append(
		bytes: Bytes,
		signal: AbortSignal,
	): Promise<{ accepted: Checkpoint; head: Checkpoint }>;
}
export interface ChainCredentials {
	readonly initialPublicKey: Bytes;
	readonly publicKey: Bytes;
	readonly signingKey: CryptoKey;
	readonly secrets: ReadonlyMap<number, Bytes>;
	readonly minimum: Checkpoint;
}
export interface ChainView {
	readonly live: ChainState | null;
	readonly syncing: boolean;
	readonly mutating: boolean;
	readonly error: string;
	readonly storageError: string;
}
export interface ChainMutation {
	readonly expected: Checkpoint;
	readonly kind: BlockKind;
	readonly effects: Effects;
	readonly plaintext?: Bytes;
}
export function stateCheckpoint(state: ChainState): Checkpoint {
	return { sequence: state.sequence, hash: bytesToHex(state.head) };
}
function cached(record: VerifiedBlock): CachedBlock {
	return {
		sequence: record.body.sequence,
		hash: bytesToHex(record.hash),
		previous: bytesToHex(record.body.previous),
		bytes: record.bytes,
	};
}
function validCheckpoint(value: Checkpoint) {
	if (
		!Number.isSafeInteger(value.sequence) ||
		value.sequence < 0 ||
		!/^[0-9a-f]{64}$/.test(value.hash)
	) {
		throw new Error("Invalid chain checkpoint.");
	}
}
export type ChainStore = ReturnType<typeof createChain>;
export function createChain(
	credentials: ChainCredentials,
	storage: ChainStorage,
	transport: ChainTransport,
	signal: AbortSignal,
): Pick<ChainStoreImpl, keyof ChainStoreImpl> {
	return new ChainStoreImpl(credentials, storage, transport, signal);
}

class ChainStoreImpl {
	private readonly credentials: ChainCredentials;
	private readonly storage: ChainStorage;
	private readonly transport: ChainTransport;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private readonly state: Writable<ChainView> = writable({
		live: null,
		syncing: false,
		mutating: false,
		error: "",
		storageError: "",
	});
	private syncing: Promise<ChainState> | null = null;
	private mutating = false;
	private disposed = false;
	readonly subscribe = this.state.subscribe;
	readonly sync = this.refresh.bind(this);
	readonly append = this.appendMutation.bind(this);
	readonly dispose = this.disposeChain.bind(this);

	constructor(
		credentials: ChainCredentials,
		storage: ChainStorage,
		transport: ChainTransport,
		signal: AbortSignal,
	) {
		validCheckpoint(credentials.minimum);
		this.credentials = credentials;
		this.storage = storage;
		this.transport = transport;
		this.signal = AbortSignal.any([signal, this.controller.signal]);
	}
	private check() {
		this.signal.throwIfAborted();
	}
	private update(patch: Partial<ChainView>) {
		this.check();
		this.state.update((state) => ({ ...state, ...patch }));
	}
	private async durable<T>(work: () => Promise<T>): Promise<T> {
		try {
			const result = await work();
			this.check();
			return result;
		} catch (error) {
			if (!this.signal.aborted) {
				this.update({ storageError: errorMessage(error) });
			}
			throw error;
		}
	}
	private secret(epoch: number) {
		const secret = this.credentials.secrets.get(epoch);
		if (!secret) {
			throw new Error(
				`Missing encryption secret for epoch ${epoch}. Re-pair this device.`,
			);
		}
		return secret;
	}
	private async apply(state: ChainState, bytes: Bytes) {
		this.check();
		const record = await verifyRecord(bytes);
		let plaintext: Bytes | undefined;
		try {
			if (record.body.kind === "data") {
				plaintext = await decryptOperation(
					record,
					this.secret(record.body.epoch),
				);
			}
			const next = reduceBlock(state, record, plaintext);
			this.check();
			return { next, record };
		} finally {
			plaintext?.fill(0);
		}
	}
	private checkPins(state: ChainState, pins: readonly Checkpoint[]) {
		for (const pin of pins) {
			if (
				state.sequence === pin.sequence &&
				bytesToHex(state.head) !== pin.hash
			) {
				throw new Error(
					"Chain does not match a trusted head. Possible rollback or fork.",
				);
			}
		}
	}
	private reached(state: ChainState, pins: readonly Checkpoint[]) {
		return pins.every((pin) => state.sequence >= pin.sequence);
	}
	private publish(state: ChainState, pins: readonly Checkpoint[]) {
		if (this.reached(state, pins)) {
			this.update({ live: state, storageError: "" });
		}
	}
	private refresh() {
		this.check();
		if (this.mutating) {
			return Promise.reject(
				new Error("A chain mutation is already in progress."),
			);
		}
		return this.runSync();
	}
	private runSync() {
		this.check();
		if (this.syncing) {
			return this.syncing;
		}
		this.update({ syncing: true, error: "" });
		this.syncing = this.synchronize()
			.catch((error: unknown) => {
				if (!this.signal.aborted) {
					this.update({ error: errorMessage(error) });
				}
				throw error;
			})
			.finally(() => {
				this.syncing = null;
				if (!this.signal.aborted) {
					this.update({ syncing: false });
				}
			});
		return this.syncing;
	}
	private async synchronize(): Promise<ChainState> {
		const initial = await initialChainState(this.credentials.initialPublicKey);
		this.check();
		const saved = await this.durable(() =>
			this.storage.ensureHead(this.credentials.minimum, this.signal),
		);
		const pins = [saved, this.credentials.minimum];
		this.checkPins(initial, pins);
		let state = initial;
		for (;;) {
			const batch = await this.durable(() =>
				this.storage.read(state.sequence, this.signal),
			);
			if (!batch.length) {
				break;
			}
			if (
				batch.some(
					(entry, index) => entry.sequence !== state.sequence + index + 1,
				)
			) {
				await this.durable(() => this.storage.discardRecords(this.signal));
				state = initial;
				break;
			}
			for (const entry of batch) {
				const applied = await this.apply(state, entry.bytes);
				const actual = cached(applied.record);
				if (
					!equalCheckpoint(entry, actual) ||
					entry.previous !== actual.previous ||
					actual.sequence > saved.sequence
				) {
					throw new Error("Invalid cached chain record.");
				}
				state = applied.next;
				this.checkPins(state, pins);
			}
		}
		this.publish(state, pins);
		let durableHead = saved;
		let target: Checkpoint | null = null;
		for (;;) {
			const page = await this.transport.read(
				bytesToHex(state.head),
				target?.hash ?? null,
				this.signal,
			);
			this.check();
			validCheckpoint(page.target);
			if (target && !equalCheckpoint(target, page.target)) {
				throw new Error("Server changed the pinned chain target.");
			}
			target ??= page.target;
			const targetSequence = target.sequence;
			if (
				target.sequence < state.sequence ||
				pins.some((pin) => targetSequence < pin.sequence)
			) {
				throw new Error("Server supplied a stale chain.");
			}
			if (
				page.records.length > MAX_PAGE_BLOCKS ||
				page.records.reduce((size, bytes) => size + bytes.length, 0) >
					MAX_PAGE_BYTES
			) {
				throw new Error("Chain page exceeds protocol limits.");
			}
			const base = stateCheckpoint(state);
			let candidate = state;
			const records: CachedBlock[] = [];
			for (const bytes of page.records) {
				const applied = await this.apply(candidate, bytes);
				candidate = applied.next;
				if (candidate.sequence > target.sequence) {
					throw new Error("Chain page extends beyond its target.");
				}
				this.checkPins(candidate, pins);
				records.push(cached(applied.record));
			}
			const end = stateCheckpoint(candidate);
			if (
				page.next !== null
					? page.next !== end.hash ||
						!records.length ||
						end.sequence >= target.sequence
					: !equalCheckpoint(end, target)
			) {
				throw new Error("Invalid chain pagination cursor or target.");
			}
			if (records.length) {
				durableHead = await this.durable(() =>
					this.storage.append(durableHead, base, records, this.signal),
				);
			}
			state = candidate;
			this.publish(state, pins);
			if (page.next === null) {
				return state;
			}
		}
	}
	private async appendMutation(mutation: ChainMutation): Promise<ChainState> {
		this.check();
		if (this.mutating) {
			throw new Error("A chain mutation is already in progress.");
		}
		this.mutating = true;
		this.update({ mutating: true, error: "" });
		try {
			const state = await this.runSync();
			const parent = stateCheckpoint(state);
			if (!equalCheckpoint(parent, mutation.expected)) {
				throw new Error("The library changed. Review your draft and retry.");
			}
			const record = await createRecord(
				{
					library: state.library,
					sequence: state.sequence + 1,
					previous: state.head,
					epoch: state.epoch,
					signer: this.credentials.publicKey,
					kind: mutation.kind,
					effects: mutation.effects,
				},
				this.credentials.signingKey,
				mutation.kind === "data"
					? {
							secret: this.secret(state.epoch),
							plaintext: mutation.plaintext ?? new Uint8Array(),
						}
					: undefined,
			);
			const candidate = (await this.apply(state, record.bytes)).next;
			try {
				const receipt = await this.transport.append(record.bytes, this.signal);
				this.check();
				if (!equalCheckpoint(receipt.accepted, stateCheckpoint(candidate))) {
					throw new Error("Server acknowledged a different chain record.");
				}
			} catch (error) {
				this.check();
				// Reconcile an uncertain outcome by locating this exact signed record.
				try {
					const reconciled = await this.runSync();
					const found = await this.storage.read(parent.sequence, this.signal);
					if (found[0]?.hash === bytesToHex(record.hash)) {
						return reconciled;
					}
				} catch {
					this.check();
				}
				throw error;
			}
			await this.durable(() =>
				this.storage.append(parent, parent, [cached(record)], this.signal),
			);
			this.update({ live: candidate, storageError: "" });
			return candidate;
		} catch (error) {
			if (!this.signal.aborted) {
				this.update({ error: errorMessage(error) });
			}
			throw error;
		} finally {
			this.mutating = false;
			if (!this.signal.aborted) {
				this.update({ mutating: false });
			}
		}
	}
	private disposeChain() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.controller.abort();
		this.storage.dispose();
		this.state.set({
			live: null,
			syncing: false,
			mutating: false,
			error: "",
			storageError: "",
		});
	}
}
