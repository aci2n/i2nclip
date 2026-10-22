import { type Writable, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import {
	type ChainState,
	type FileOperation,
	type HistoryEntry,
	inverseOperation,
	type MaterializedFile,
} from "../protocol/chain-state.ts";
import type { Files } from "../services/files.ts";
import type { ChainStore } from "./chain.ts";

/** Plain presentation data for one block; no key material. */
export interface TimelineItem {
	readonly sequence: number;
	readonly time: number;
	readonly action: FileOperation["kind"];
	readonly name: string;
	readonly undoable: boolean;
	readonly error: string;
}
export interface HistoryState {
	readonly items: readonly TimelineItem[];
	readonly more: boolean;
	readonly loading: boolean;
	readonly error: string;
	readonly undoing: number | null;
}
interface Services {
	readonly changed?: () => unknown;
}
const PAGE = 50;
// The server admits two concurrent downloads per library key.
const NAME_CONCURRENCY = 2;
export type History = ReturnType<typeof createHistory>;
export function createHistory(
	chain: ChainStore,
	files: Pick<Files, "metadata" | "revertMetadata">,
	signal: AbortSignal,
	services: Services = {},
): Pick<HistoryStoreImpl, keyof HistoryStoreImpl> {
	return new HistoryStoreImpl(chain, files, signal, services);
}
class HistoryStoreImpl {
	private readonly chain: ChainStore;
	private readonly files: Pick<Files, "metadata" | "revertMetadata">;
	private readonly changed: () => unknown;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private loading = new AbortController();
	private naming = new AbortController();
	private readonly unsubscribe: () => void;
	private live: ChainState | null = null;
	/** Newest first. */
	private entries: readonly HistoryEntry[] = [];
	/** The head whose history is loaded or loading. */
	private target = "";
	private loadedHead = "";
	private active = false;
	private shown = PAGE;
	private busy = false;
	private error = "";
	private undoing: number | null = null;
	private readonly names = new Map<string, { hash: string; name: string }>();
	private readonly failures = new Map<number, string>();
	private readonly state: Writable<HistoryState> = writable({
		items: [],
		more: false,
		loading: false,
		error: "",
		undoing: null,
	});
	readonly subscribe = this.state.subscribe;
	readonly open = this.openHistory.bind(this);
	readonly close = this.closeHistory.bind(this);
	readonly more = this.showMore.bind(this);
	readonly undo = this.undoEntry.bind(this);
	readonly dispose = this.disposeHistory.bind(this);
	constructor(
		chain: ChainStore,
		files: Pick<Files, "metadata" | "revertMetadata">,
		signal: AbortSignal,
		services: Services,
	) {
		this.chain = chain;
		this.files = files;
		this.changed = services.changed ?? (() => {});
		this.signal = AbortSignal.any([signal, this.controller.signal]);
		this.unsubscribe = chain.subscribe((value) => {
			if (this.signal.aborted) {
				return;
			}
			this.live = value.live;
			this.publish();
			if (this.active) {
				void this.reload();
			}
		});
		this.signal.addEventListener("abort", this.dispose, { once: true });
	}
	private publish() {
		if (this.signal.aborted) {
			return;
		}
		const live = this.live;
		this.state.set({
			items: this.entries.slice(0, this.shown).map((entry) => ({
				sequence: entry.sequence,
				time: entry.time,
				action: entry.operation.kind,
				name: this.name(entry),
				undoable:
					live !== null &&
					this.undoing === null &&
					inverseOperation(entry, live) !== null,
				error: this.failures.get(entry.sequence) ?? "",
			})),
			more: this.entries.length > this.shown,
			loading: this.busy,
			error: this.error,
			undoing: this.undoing,
		});
	}
	private name(entry: HistoryEntry) {
		const id = bytesToHex(entry.operation.id);
		const file = this.live?.files.get(id);
		if (file?.purged) {
			return "Purged file";
		}
		return this.names.get(id)?.name ?? `File ${id.slice(0, 8)}`;
	}
	private openHistory() {
		this.signal.throwIfAborted();
		this.active = true;
		return this.reload();
	}
	private closeHistory() {
		this.active = false;
		this.loading.abort();
		this.naming.abort();
		this.target = this.loadedHead;
		this.busy = false;
		this.publish();
	}
	private async reload() {
		const live = this.live;
		const head = live ? bytesToHex(live.head) : "";
		if (!head || head === this.target) {
			return;
		}
		this.target = head;
		this.loading.abort();
		this.loading = new AbortController();
		const signal = AbortSignal.any([this.signal, this.loading.signal]);
		this.busy = true;
		this.error = "";
		this.publish();
		try {
			const entries = await this.chain.history(signal);
			signal.throwIfAborted();
			this.entries = entries.reverse();
			this.loadedHead = head;
			this.busy = false;
			this.publish();
			void this.resolveNames();
		} catch (error) {
			if (!signal.aborted) {
				this.target = this.loadedHead;
				this.busy = false;
				this.error = errorMessage(error);
				this.publish();
			}
		}
	}
	private showMore() {
		this.shown += PAGE;
		this.publish();
		void this.resolveNames();
	}
	// Current names of the files shown; each read is skipped once cached.
	private async resolveNames() {
		this.naming.abort();
		this.naming = new AbortController();
		const signal = AbortSignal.any([this.signal, this.naming.signal]);
		const pending = new Map<string, MaterializedFile>();
		for (const entry of this.entries.slice(0, this.shown)) {
			const id = bytesToHex(entry.operation.id);
			const file = this.live?.files.get(id);
			if (
				file &&
				!file.purged &&
				this.names.get(id)?.hash !== bytesToHex(file.metadata.hash)
			) {
				pending.set(id, file);
			}
		}
		const queue = [...pending.values()];
		const worker = async () => {
			for (let file = queue.shift(); file; file = queue.shift()) {
				const id = bytesToHex(file.id);
				let name = "";
				try {
					name =
						(await this.files.metadata(file, signal)).attributes.name ?? "";
				} catch {
					// An unreadable name keeps the short ID fallback.
				}
				if (signal.aborted) {
					return;
				}
				if (name) {
					this.names.set(id, { hash: bytesToHex(file.metadata.hash), name });
					this.publish();
				}
			}
		};
		await Promise.all(Array.from({ length: NAME_CONCURRENCY }, worker));
	}
	private async undoEntry(sequence: number) {
		const entry = this.entries.find((item) => item.sequence === sequence);
		if (this.signal.aborted || this.undoing !== null || !entry) {
			return false;
		}
		const signal = this.signal;
		this.undoing = sequence;
		this.failures.delete(sequence);
		this.publish();
		try {
			const state = await this.chain.sync();
			signal.throwIfAborted();
			const inverse = inverseOperation(entry, state);
			const file = state.files.get(bytesToHex(entry.operation.id));
			if (!inverse || !file) {
				throw new Error("This change can no longer be undone.");
			}
			if (inverse.kind === "ReplaceMetadata") {
				await this.files.revertMetadata(file, inverse.metadata, signal);
			} else {
				await this.chain.append({
					check: (current) => {
						if (!inverseOperation(entry, current)) {
							throw new Error("This change can no longer be undone.");
						}
					},
					effects: [],
					operation: inverse,
					signal,
				});
			}
			await this.changed();
			return true;
		} catch (error) {
			if (!signal.aborted) {
				this.failures.set(sequence, errorMessage(error));
			}
			return false;
		} finally {
			this.undoing = null;
			this.publish();
		}
	}
	private disposeHistory() {
		if (this.controller.signal.aborted) {
			return;
		}
		this.signal.removeEventListener("abort", this.dispose);
		this.controller.abort();
		this.loading.abort();
		this.naming.abort();
		this.unsubscribe();
		this.entries = [];
		this.names.clear();
		this.failures.clear();
		this.state.set({
			items: [],
			more: false,
			loading: false,
			error: "",
			undoing: null,
		});
	}
}
