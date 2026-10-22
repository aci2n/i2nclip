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
	type BlockPayload,
	type ChainState,
	decodeBlockPayload,
	encodeBlockPayload,
	type FileOperation,
	type HistoryEntry,
	initialChainState,
	reduceBlock,
} from "../protocol/chain-state.ts";
import { HttpError } from "../services/library-api.ts";
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
	readonly error: string;
	readonly storageError: string;
}
export interface ChainMutation {
	/** Throws when the draft no longer applies to the current verified state. */
	readonly check?: (state: ChainState) => void;
	readonly effects: Effects;
	readonly operation: FileOperation;
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
// A concurrent writer can win the race for the same parent; rebase onto it.
const APPEND_ATTEMPTS = 3;
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
		error: "",
		storageError: "",
	});
	private syncing: Promise<ChainState> | null = null;
	private mutations: Promise<unknown> = Promise.resolve();
	private queued = 0;
	private disposed = false;
	readonly subscribe = this.state.subscribe;
	readonly sync = this.refresh.bind(this);
	readonly at = this.replayAt.bind(this);
	readonly history = this.replayHistory.bind(this);
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
			return {
				next: reduceBlock(state, record, plaintext),
				record,
				payload: decodeBlockPayload(plaintext),
			};
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
	// Wait for queued mutations so a refresh never races storing their records.
	private refresh() {
		this.check();
		return this.queued
			? this.mutations.then(() => this.runSync())
			: this.runSync();
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
		let selected: ChainState | null = null;
		await this.replay(live, caller, (before, after) => {
			if (before.sequence === sequence) {
				selected = before;
			} else if (after.sequence === sequence) {
				selected = after;
			}
		});
		// An empty chain has no blocks to visit; replay verified genesis is live.
		return selected ?? live;
	}
	private async replayHistory(caller: AbortSignal): Promise<HistoryEntry[]> {
		const live = get(this.state).live;
		if (!live) {
			throw new Error("The library is not loaded yet.");
		}
		const entries: HistoryEntry[] = [];
		await this.replay(live, caller, (before, after, payload) => {
			const { operation } = payload;
			entries.push({
				...payload,
				sequence: after.sequence,
				previous:
					operation.kind === "ReplaceMetadata"
						? (before.files.get(bytesToHex(operation.id))?.metadata ?? null)
						: null,
			});
		});
		return entries;
	}
	/** Verifies every cached block from genesis up to the trusted live head. */
	private async replay(
		live: ChainState,
		caller: AbortSignal,
		visit: (
			before: ChainState,
			after: ChainState,
			payload: BlockPayload,
		) => void,
	) {
		const signal = AbortSignal.any([this.signal, caller]);
		signal.throwIfAborted();
		let state = await initialChainState(this.credentials.genesis);
		if (!sameBytes(state.publicKey, this.credentials.signing.publicKey)) {
			throw new Error("Library signing key does not match genesis.");
		}
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
				visit(state, applied.next, applied.payload);
				state = applied.next;
				if (state.sequence === live.sequence) {
					break;
				}
			}
		}
		signal.throwIfAborted();
		if (bytesToHex(state.head) !== bytesToHex(live.head)) {
			throw new Error("Cached history conflicts with the verified live head.");
		}
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
	private appendMutation(mutation: ChainMutation): Promise<ChainState> {
		this.check();
		this.queued++;
		const run = this.mutations
			.then(() => this.commitMutation(mutation))
			.finally(() => {
				this.queued--;
			});
		this.mutations = run.catch(() => {});
		return run;
	}
	private async commitMutation(mutation: ChainMutation): Promise<ChainState> {
		const signal = mutation.signal
			? AbortSignal.any([this.signal, mutation.signal])
			: this.signal;
		try {
			for (let attempt = 1; ; attempt++) {
				try {
					return await this.appendOnce(mutation, signal);
				} catch (error) {
					const conflict = error instanceof HttpError && error.status === 409;
					if (!conflict || attempt === APPEND_ATTEMPTS) {
						throw error;
					}
				}
			}
		} catch (error) {
			if (!this.signal.aborted) {
				this.update({ error: errorMessage(error) });
			}
			throw error;
		}
	}
	private async appendOnce(
		mutation: ChainMutation,
		signal: AbortSignal,
	): Promise<ChainState> {
		signal.throwIfAborted();
		this.update({ error: "" });
		const state = await this.runSync();
		signal.throwIfAborted();
		mutation.check?.(state);
		const parent = stateCheckpoint(state);
		const plaintext = encodeBlockPayload({
			time: Date.now(),
			operation: mutation.operation,
		});
		let record: VerifiedBlock;
		try {
			record = await createRecord(
				{
					library: state.library,
					sequence: state.sequence + 1,
					previous: state.head,
					effects: mutation.effects,
				},
				this.credentials.signing,
				this.credentials.encryption,
				plaintext,
			);
		} finally {
			plaintext.fill(0);
		}
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
			error: "",
			storageError: "",
		});
	}
}
