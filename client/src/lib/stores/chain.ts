import { get, type Writable, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import type { SigningKey } from "../protocol/auth.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	decryptOperation,
	type Effects,
	MAX_PAGE_BLOCKS,
	MAX_PAGE_BYTES,
	sameBytes,
	type VerifiedBlock,
	verifyRecord,
} from "../protocol/chain.ts";
import {
	type ChainState,
	initialChainState,
	reduceBlock,
} from "../protocol/chain-state.ts";
import {
	type CachedBlock,
	type ChainStorage,
	type Checkpoint,
	equalCheckpoint,
} from "../storage/chain.ts";

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
	readonly genesis: Bytes;
	readonly signing: SigningKey;
	readonly encryption: CryptoKey;
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
	readonly effects: Effects;
	readonly plaintext: Bytes;
	readonly signal?: AbortSignal;
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
	readonly at = this.replayAt.bind(this);
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
	private async apply(state: ChainState, bytes: Bytes) {
		this.check();
		const record = await verifyRecord(bytes, state.publicKey);
		this.check();
		const plaintext = await decryptOperation(
			record,
			this.credentials.encryption,
		);
		try {
			this.check();
			return { next: reduceBlock(state, record, plaintext), record };
		} finally {
			plaintext.fill(0);
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

	private async replayAt(
		sequence: number,
		caller: AbortSignal,
	): Promise<ChainState> {
		const live = get(this.state).live;
		if (
			!live ||
			!Number.isSafeInteger(sequence) ||
			sequence < 0 ||
			sequence > live.sequence
		) {
			throw new Error("Choose a sequence within the verified chain.");
		}
		const signal = AbortSignal.any([this.signal, caller]);
		signal.throwIfAborted();
		let state = await initialChainState(this.credentials.genesis);
		if (!sameBytes(state.publicKey, this.credentials.signing.publicKey)) {
			throw new Error("Library signing key does not match genesis.");
		}
		let selected: ChainState | null = sequence === 0 ? state : null;
		// Verify the suffix too: the selected prefix must reach the trusted live head.
		while (state.sequence < live.sequence) {
			const batch = await this.storage.read(state.sequence, signal);
			if (!batch.length) {
				throw new Error(
					"Cached history is incomplete. Refresh before choosing a block.",
				);
			}
			for (const entry of batch) {
				signal.throwIfAborted();
				const applied = await this.apply(state, entry.bytes);
				if (
					!equalCheckpoint(entry, cached(applied.record)) ||
					entry.previous !== bytesToHex(applied.record.body.previous)
				) {
					throw new Error("Invalid cached historical record.");
				}
				state = applied.next;
				if (state.sequence === sequence) {
					selected = state;
				}
				if (state.sequence === live.sequence) {
					break;
				}
			}
		}
		signal.throwIfAborted();
		if (!selected || bytesToHex(state.head) !== bytesToHex(live.head)) {
			throw new Error("Cached history conflicts with the verified live head.");
		}
		return selected;
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
		const initial = await initialChainState(this.credentials.genesis);
		this.check();
		const observed = get(this.state).live;
		const observedHead = observed ? stateCheckpoint(observed) : null;
		const minimum =
			observedHead && observedHead.sequence > this.credentials.minimum.sequence
				? observedHead
				: this.credentials.minimum;
		const saved = await this.durable(() =>
			this.storage.ensureHead(minimum, this.signal),
		);
		const pins = [
			saved,
			this.credentials.minimum,
			...(observedHead ? [observedHead] : []),
		];
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
		const signal = mutation.signal
			? AbortSignal.any([this.signal, mutation.signal])
			: this.signal;
		signal.throwIfAborted();
		if (this.mutating) {
			throw new Error("A chain mutation is already in progress.");
		}
		this.mutating = true;
		this.update({ mutating: true, error: "" });
		try {
			const state = await this.runSync();
			signal.throwIfAborted();
			const parent = stateCheckpoint(state);
			if (!equalCheckpoint(parent, mutation.expected)) {
				throw new Error("The library changed. Review your draft and retry.");
			}
			const record = await createRecord(
				{
					library: state.library,
					sequence: state.sequence + 1,
					previous: state.head,
					effects: mutation.effects,
				},
				this.credentials.signing,
				this.credentials.encryption,
				mutation.plaintext,
			);
			const candidate = (await this.apply(state, record.bytes)).next;
			signal.throwIfAborted();
			try {
				const receipt = await this.transport.append(record.bytes, signal);
				signal.throwIfAborted();
				this.check();
				if (!equalCheckpoint(receipt.accepted, stateCheckpoint(candidate))) {
					throw new Error("Server acknowledged a different chain record.");
				}
			} catch (error) {
				signal.throwIfAborted();
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
				this.storage.append(parent, parent, [cached(record)], signal),
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
