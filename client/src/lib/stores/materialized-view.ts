import { get, type Writable, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import type { ChainState, MaterializedFile } from "../protocol/chain-state.ts";
import type { FileMetadata } from "../protocol/file-objects.ts";
import type { Files } from "../services/files.ts";
import type { ChainStore } from "./chain.ts";

export interface MaterializedViewState {
	readonly selected: ChainState | null;
	readonly historical: boolean;
	readonly unavailable: ReadonlySet<string>;
	readonly selecting: boolean;
	readonly selectionError: string;
	readonly revision: number;
	readonly metadata: ReadonlyMap<string, FileMetadata>;
	readonly errors: ReadonlyMap<string, string>;
	readonly indexing: boolean;
	readonly indexScope: "active" | "deleted";
	readonly indexed: number;
	readonly total: number;
	readonly complete: boolean;
	readonly chainError: string;
}
export interface SelectedFile {
	readonly file: MaterializedFile;
	readonly metadata: FileMetadata;
	readonly revision: number;
}
// The server admits two concurrent downloads per library key.
const INDEX_CONCURRENCY = 2;
function referenceKey(file: MaterializedFile) {
	return `${bytesToHex(file.metadata.hash)}:${bytesToHex(file.metadata.key)}`;
}
export type MaterializedView = ReturnType<typeof createMaterializedView>;
export function createMaterializedView(
	chain: ChainStore,
	files: Pick<Files, "metadata">,
	signal: AbortSignal,
): Pick<MaterializedViewImpl, keyof MaterializedViewImpl> {
	return new MaterializedViewImpl(chain, files, signal);
}
class MaterializedViewImpl {
	private readonly chain: ChainStore;
	private readonly files: Pick<Files, "metadata">;
	private readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private selection = new AbortController();
	private choosing = new AbortController();
	private indexController = new AbortController();
	private indexDeleted = false;
	private unavailable = new Set<string>();
	private readonly state: Writable<MaterializedViewState> = writable({
		selected: null,
		historical: false,
		unavailable: new Set<string>(),
		selecting: false,
		selectionError: "",
		revision: 0,
		metadata: new Map(),
		errors: new Map(),
		indexing: false,
		indexScope: "active",
		indexed: 0,
		total: 0,
		complete: false,
		chainError: "",
	});
	private readonly cache = new Map<
		string,
		{ reference: string; metadata: FileMetadata }
	>();
	private readonly unsubscribe: () => void;
	private indexing: Promise<void> | null = null;
	readonly subscribe = this.state.subscribe;
	readonly index = this.indexSelected.bind(this);
	readonly file = this.readSelectedFile.bind(this);
	readonly refresh = this.refreshChain.bind(this);
	readonly select = this.selectSequence.bind(this);
	readonly dispose = this.disposeView.bind(this);
	constructor(
		chain: ChainStore,
		files: Pick<Files, "metadata">,
		signal: AbortSignal,
	) {
		this.chain = chain;
		this.files = files;
		this.signal = AbortSignal.any([signal, this.controller.signal]);
		this.unsubscribe = chain.subscribe((value) => {
			if (this.signal.aborted) {
				return;
			}
			this.state.update((state) => ({ ...state, chainError: value.error }));
			if (value.live) {
				this.unavailable = new Set(
					[...value.live.files]
						.filter(([, file]) => file.purged)
						.map(([id]) => id),
				);
				const selected = get(this.state);
				if (selected.historical && selected.selected) {
					this.installSelection(selected.selected, true);
				} else {
					this.installSelection(value.live, false);
				}
			}
		});
		this.signal.addEventListener("abort", this.dispose, { once: true });
	}
	private installSelection(selected: ChainState, historical: boolean) {
		const previous = get(this.state);
		if (
			previous.selected &&
			bytesToHex(previous.selected.head) === bytesToHex(selected.head) &&
			previous.historical === historical &&
			previous.unavailable.size === this.unavailable.size &&
			[...this.unavailable].every((id) => previous.unavailable.has(id))
		) {
			return;
		}
		this.selection.abort();
		this.selection = new AbortController();
		this.indexController.abort();
		this.indexing = null;
		const metadata = new Map<string, FileMetadata>();
		for (const [id, entry] of this.cache) {
			const file = selected.files.get(id);
			if (
				!file ||
				file.purged ||
				this.unavailable.has(id) ||
				referenceKey(file) !== entry.reference
			) {
				this.cache.delete(id);
			} else {
				metadata.set(id, entry.metadata);
			}
		}
		this.state.set({
			selected,
			historical,
			unavailable: new Set(this.unavailable),
			selecting: false,
			selectionError: "",
			revision: previous.revision + 1,
			metadata,
			errors: new Map(),
			indexing: false,
			indexScope: "active",
			indexed: 0,
			total: 0,
			complete: false,
			chainError: previous.chainError,
		});
	}
	private async readSelectedFile(
		id: string,
		own: AbortSignal,
	): Promise<SelectedFile> {
		const source = get(this.state);
		const file = source.selected?.files.get(id);
		if (!file) {
			throw new Error("File not found in the selected library state.");
		}
		if (file.purged || source.unavailable.has(id)) {
			throw new Error("This file was permanently purged.");
		}
		const signal = AbortSignal.any([this.signal, this.selection.signal, own]);
		signal.throwIfAborted();
		let metadata = this.cache.get(id)?.metadata;
		if (!metadata) {
			metadata = await this.files.metadata(file, signal);
		}
		signal.throwIfAborted();
		if (get(this.state).revision !== source.revision) {
			throw new DOMException("Selected library state changed.", "AbortError");
		}
		this.cache.set(id, { reference: referenceKey(file), metadata });
		const loaded = metadata;
		this.state.update((state) => ({
			...state,
			metadata: new Map(state.metadata).set(id, loaded),
		}));
		return { file, metadata, revision: source.revision };
	}
	private indexSelected(deletedOnly = false) {
		this.signal.throwIfAborted();
		if (this.indexing && this.indexDeleted === deletedOnly) {
			return this.indexing;
		}
		this.indexController.abort();
		this.indexController = new AbortController();
		this.indexDeleted = deletedOnly;
		const source = get(this.state);
		if (!source.selected) {
			return Promise.resolve();
		}
		const signal = AbortSignal.any([
			this.signal,
			this.selection.signal,
			this.indexController.signal,
		]);
		const files = [...source.selected.files.values()].filter(
			(file) => file.deleted === deletedOnly && !file.purged,
		);
		this.state.update((state) => ({
			...state,
			indexing: true,
			indexScope: deletedOnly ? "deleted" : "active",
			indexed: 0,
			total: files.length,
			complete: false,
			errors: new Map(),
		}));
		const task = this.runIndex(files, source.revision, signal).finally(() => {
			if (this.indexing === task) {
				this.indexing = null;
			}
		});
		this.indexing = task;
		return task;
	}
	private async runIndex(
		files: readonly MaterializedFile[],
		revision: number,
		outer: AbortSignal,
	) {
		// One stopped worker stops the other before it starts another read.
		const controller = new AbortController();
		const signal = AbortSignal.any([outer, controller.signal]);
		let next = 0;
		let indexed = 0;
		const errors = new Map<string, string>();
		const worker = async () => {
			while (next < files.length) {
				signal.throwIfAborted();
				const id = bytesToHex(files[next++].id);
				try {
					await this.readSelectedFile(id, signal);
				} catch (error) {
					signal.throwIfAborted();
					errors.set(id, errorMessage(error));
				}
				signal.throwIfAborted();
				indexed++;
				if (get(this.state).revision !== revision) {
					throw new DOMException(
						"Selected library state changed.",
						"AbortError",
					);
				}
				this.state.update((state) => ({
					...state,
					indexed,
					errors: new Map(errors),
				}));
			}
		};
		try {
			await Promise.all(Array.from({ length: INDEX_CONCURRENCY }, worker));
		} catch (error) {
			controller.abort();
			throw error;
		}
		signal.throwIfAborted();
		this.state.update((state) => ({
			...state,
			indexing: false,
			complete: errors.size === 0,
		}));
	}
	private async selectSequence(sequence: number | null) {
		this.signal.throwIfAborted();
		this.choosing.abort();
		this.choosing = new AbortController();
		const signal = AbortSignal.any([this.signal, this.choosing.signal]);
		this.state.update((state) => ({
			...state,
			selecting: true,
			selectionError: "",
		}));
		try {
			const state =
				sequence === null
					? (get(this.chain).live ?? (await this.chain.sync()))
					: await this.chain.at(sequence, signal);
			signal.throwIfAborted();
			this.installSelection(state, sequence !== null);
			return true;
		} catch (error) {
			if (!signal.aborted) {
				this.state.update((state) => ({
					...state,
					selectionError: errorMessage(error),
				}));
			}
			return false;
		} finally {
			if (!signal.aborted) {
				this.state.update((state) => ({ ...state, selecting: false }));
			}
		}
	}

	private refreshChain() {
		return this.chain.sync();
	}
	private disposeView() {
		if (this.controller.signal.aborted) {
			return;
		}
		this.signal.removeEventListener("abort", this.dispose);
		this.controller.abort();
		this.selection.abort();
		this.choosing.abort();
		this.indexController.abort();
		this.unsubscribe();
		this.cache.clear();
		this.state.set({
			selected: null,
			historical: false,
			unavailable: new Set<string>(),
			selecting: false,
			selectionError: "",
			revision: get(this.state).revision + 1,
			metadata: new Map(),
			errors: new Map(),
			indexing: false,
			indexScope: "active",
			indexed: 0,
			total: 0,
			complete: false,
			chainError: "",
		});
	}
}
