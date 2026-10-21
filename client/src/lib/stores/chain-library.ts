import { get, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import type { Files, PreparedFileChange } from "../files.ts";
import type { MediaDisplay } from "../media/display.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import { type Bytes, sameBytes } from "../protocol/chain.ts";
import {
	encodeOperation,
	type MaterializedFile,
} from "../protocol/chain-state.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { encode } from "../protocol/msgpack.ts";
import { normalizeTag } from "../protocol/tags.ts";
import type { ChainStore } from "./chain.ts";
import { stateCheckpoint } from "./chain.ts";
import type { ContentStreams } from "./content-streams.ts";
import {
	createFileMedia,
	FileContentSource,
	type FileMedia,
	type FileMediaState,
} from "./file-media.ts";
import type { Session } from "./identity.ts";
import type {
	MaterializedView,
	MaterializedViewState,
} from "./materialized-view.ts";

export interface LibraryCard extends MediaDisplay {
	readonly createdSequence: number;
	readonly deleted: boolean;
	readonly unavailable: boolean;
}
export interface ChainLibraryState {
	readonly cards: readonly LibraryCard[];
	readonly query: string;
	readonly deleted: boolean;
	readonly suggestions: readonly string[];
	readonly more: boolean;
	readonly loading: boolean;
	readonly incomplete: boolean;
	readonly empty: "library" | "search" | "deleted" | null;
	readonly status: string;
	readonly readonly: boolean;
	readonly preview: LibraryCard | null;
	readonly opener: HTMLElement | undefined;
}
interface Resource {
	key: string;
	media: FileMedia;
	value: FileMediaState;
	unsubscribe: () => void;
}
interface Services {
	readonly confirm?: (message: string) => boolean;
	readonly save?: (url: string, name: string) => unknown;
	readonly changed?: () => unknown;
}
const emptyResource = (): FileMediaState => ({
	ready: false,
	busy: false,
	url: "",
	preview: "",
	text: null,
	textTruncated: false,
	message: "",
	error: false,
});
function resourceKey(file: MaterializedFile) {
	return [
		file.manifest.hash,
		file.manifest.key,
		file.metadata.hash,
		file.metadata.key,
	]
		.map(bytesToHex)
		.join(":");
}
function folded(value: string) {
	return value.trim().normalize("NFC").toLowerCase();
}
export type ChainLibrary = ReturnType<typeof createChainLibrary>;
export function createChainLibrary(
	session: Session,
	chain: ChainStore,
	view: MaterializedView,
	files: Files,
	streams: ContentStreams,
	signal: AbortSignal,
	services: Services = {},
): Pick<ChainLibraryImpl, keyof ChainLibraryImpl> {
	return new ChainLibraryImpl(
		session,
		chain,
		view,
		files,
		streams,
		signal,
		services,
	);
}
class ChainLibraryImpl {
	private readonly session: Session;
	private readonly chain: ChainStore;
	private readonly view: MaterializedView;
	private readonly files: Files;
	private readonly streams: ContentStreams;
	private readonly confirm: (message: string) => boolean;
	private readonly save: (url: string, name: string) => unknown;
	private readonly changed: () => unknown;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private readonly resources = new Map<string, Resource>();
	private readonly failures = new Map<string, string>();
	private readonly downloads = new Map<string, AbortController>();
	private readonly prepared = new Map<
		string,
		{ draft: Bytes; change: PreparedFileChange }
	>();
	private readonly purged = new Set<string>();
	private readonly subscriptions: Array<() => void> = [];
	private mutation: AbortController | null = null;
	private mutatingId: string | null = null;
	private previewController = new AbortController();
	private previewId: string | null = null;
	private opener: HTMLElement | undefined;
	private opening = false;
	private browsing = false;
	private limit = 40;
	private query = "";
	private deleted = false;
	private error = "";
	private revision = -1;
	private readonly state = writable<ChainLibraryState>({
		cards: [],
		query: "",
		deleted: false,
		suggestions: [],
		more: false,
		loading: false,
		incomplete: false,
		empty: null,
		status: "",
		readonly: true,
		preview: null,
		opener: undefined,
	});
	readonly subscribe = this.state.subscribe;
	readonly browse = this.browseLibrary.bind(this);
	readonly refresh = this.refreshLibrary.bind(this);
	readonly search = this.searchLibrary.bind(this);
	readonly showDeleted = this.changeScope.bind(this);
	readonly more = this.showMore.bind(this);
	readonly reveal = this.openFile.bind(this);
	readonly closePreview = this.closeFile.bind(this);
	readonly download = this.downloadFile.bind(this);
	readonly updateMetadata = this.editFile.bind(this);
	readonly remove = this.deleteFile.bind(this);
	readonly restore = this.restoreFile.bind(this);
	readonly purge = this.purgeFile.bind(this);
	readonly dispose = this.disposeLibrary.bind(this);
	constructor(
		session: Session,
		chain: ChainStore,
		view: MaterializedView,
		files: Files,
		streams: ContentStreams,
		signal: AbortSignal,
		services: Services,
	) {
		this.session = session;
		this.chain = chain;
		this.view = view;
		this.files = files;
		this.streams = streams;
		this.signal = AbortSignal.any([signal, this.controller.signal]);
		this.confirm =
			services.confirm ?? ((message) => globalThis.confirm(message));
		this.save = services.save ?? saveDownload;
		this.changed = services.changed ?? (() => {});
		this.subscriptions.push(
			view.subscribe(this.selectionChanged.bind(this)),
			chain.subscribe(this.publish.bind(this)),
			session.subscribe(this.sessionChanged.bind(this)),
		);
	}
	private readonlyView() {
		const context = get(this.session).context;
		const member = context
			? get(this.chain).live?.devices.get(bytesToHex(context.key.publicKey))
			: null;
		return (
			this.signal.aborted ||
			!context ||
			!get(this.view).selected ||
			get(this.view).historical ||
			get(this.session).pendingRotation ||
			get(this.session).busy ||
			member?.revokedAt !== null
		);
	}

	private sessionChanged() {
		if (this.readonlyView()) {
			this.mutation?.abort();
		}
		this.publish();
	}
	private selectionChanged(value: MaterializedViewState) {
		if (this.signal.aborted) {
			return;
		}
		if (value.historical) {
			this.mutation?.abort();
		}
		if (value.revision !== this.revision) {
			this.revision = value.revision;
			this.prepared.clear();
			if (this.browsing) {
				this.ensureIndex();
			}
		}
		for (const id of value.unavailable) {
			if (!this.purged.has(id)) {
				this.purged.add(id);
				this.downloads.get(id)?.abort();
				this.streams.invalidate(id);
			}
		}
		this.reconcileResources();
	}
	private candidates() {
		const source = get(this.view);
		return [...(source.selected?.files.values() ?? [])]
			.filter((file) => !file.purged && file.deleted === this.deleted)
			.sort((a, b) => b.createdSequence - a.createdSequence)
			.filter((file) => {
				if (!this.query) {
					return true;
				}
				const metadata = source.metadata.get(bytesToHex(file.id));
				if (!metadata) {
					return false;
				}
				const query = folded(this.query);
				return (
					folded(metadata.attributes.name ?? "").includes(query) ||
					(metadata.attributes.tags ?? []).some((tag) =>
						folded(tag).includes(query),
					)
				);
			});
	}
	private reconcileResources() {
		if (this.signal.aborted) {
			return;
		}
		const source = get(this.view);
		const visible = this.candidates().slice(0, this.limit);
		const ids = new Set(visible.map((file) => bytesToHex(file.id)));
		if (this.previewId) {
			ids.add(this.previewId);
		}
		for (const [id, resource] of this.resources) {
			const file = source.selected?.files.get(id);
			if (
				!ids.has(id) ||
				!file ||
				file.purged ||
				source.unavailable.has(id) ||
				resource.key !== resourceKey(file)
			) {
				resource.unsubscribe();
				resource.media.dispose();
				this.resources.delete(id);
			}
		}
		for (const id of ids) {
			const file = source.selected?.files.get(id);
			const metadata = source.metadata.get(id);
			if (
				!file ||
				!metadata ||
				file.purged ||
				source.unavailable.has(id) ||
				this.resources.has(id)
			) {
				continue;
			}
			const media = createFileMedia(
				file,
				metadata,
				this.files,
				this.streams,
				this.signal,
			);
			const resource: Resource = {
				key: resourceKey(file),
				media,
				value: get(media),
				unsubscribe: () => {},
			};
			this.resources.set(id, resource);
			resource.unsubscribe = media.subscribe((value) => {
				resource.value = value;
				this.publish();
			});
		}
		this.publish();
		void this.loadThumbnails();
	}
	private thumbnails: Promise<void> | null = null;
	private loadThumbnails() {
		if (this.thumbnails) {
			return this.thumbnails;
		}
		const task = this.readThumbnails().finally(() => {
			if (this.thumbnails === task) {
				this.thumbnails = null;
			}
		});
		this.thumbnails = task;
		return task;
	}
	private async readThumbnails() {
		for (const resource of this.resources.values()) {
			if (this.signal.aborted) {
				return;
			}
			await resource.media.thumbnail();
		}
	}
	private display(file: MaterializedFile): LibraryCard {
		const source = get(this.view);
		const id = bytesToHex(file.id);
		const metadata = source.metadata.get(id);
		const resource = this.resources.get(id)?.value ?? emptyResource();
		const message =
			this.failures.get(id) || source.errors.get(id) || resource.message;
		return {
			...resource,
			id,
			createdSequence: file.createdSequence,
			metadata: metadata?.attributes ?? null,
			deleted: file.deleted,
			unavailable: file.purged || source.unavailable.has(id),
			busy:
				resource.busy ||
				this.mutatingId === id ||
				this.downloads.has(id) ||
				(this.previewId === id && this.opening),
			message,
			error: Boolean(message),
		};
	}
	private publish() {
		if (this.signal.aborted) {
			return;
		}
		const source = get(this.view);
		const candidates = this.candidates();
		const cards = candidates.slice(0, this.limit).map(this.display.bind(this));
		const tags = new Map<string, string>();
		for (const file of source.selected?.files.values() ?? []) {
			if (file.purged || file.deleted !== this.deleted) {
				continue;
			}
			for (const tag of source.metadata.get(bytesToHex(file.id))?.attributes
				.tags ?? []) {
				const key = normalizeTag(tag);
				if (!tags.has(key)) {
					tags.set(key, tag);
				}
			}
		}
		const matchingScope =
			source.indexScope === (this.deleted ? "deleted" : "active");
		const complete = source.complete && matchingScope;
		const previewFile = this.previewId
			? source.selected?.files.get(this.previewId)
			: null;
		this.state.set({
			cards,
			query: this.query,
			deleted: this.deleted,
			suggestions: [...tags.values()].sort(),
			more: candidates.length > this.limit,
			loading: get(this.chain).syncing || source.indexing,
			incomplete: !complete && Boolean(source.selected),
			empty:
				complete && !cards.length
					? this.query
						? "search"
						: this.deleted
							? "deleted"
							: "library"
					: null,
			status: this.error || source.selectionError || source.chainError,
			readonly: this.readonlyView(),
			preview: previewFile ? this.display(previewFile) : null,
			opener: this.opener,
		});
	}
	private ensureIndex() {
		void this.view.index(this.deleted).catch((error) => {
			if (
				!this.signal.aborted &&
				!(error instanceof DOMException && error.name === "AbortError")
			) {
				this.error = errorMessage(error);
				this.publish();
			}
		});
	}
	private async browseLibrary() {
		this.browsing = true;
		return this.refreshLibrary();
	}
	private async refreshLibrary() {
		this.error = "";
		try {
			await this.chain.sync();
			if (this.browsing) {
				await this.view.index(this.deleted);
			}
			return true;
		} catch (error) {
			if (!this.signal.aborted) {
				this.error = errorMessage(error);
				this.publish();
			}
			return false;
		}
	}
	private searchLibrary(query: string) {
		this.query = query.trim();
		this.limit = 40;
		this.closeFile();
		this.reconcileResources();
	}
	private changeScope(deleted: boolean) {
		this.deleted = deleted;
		this.limit = 40;
		this.closeFile();
		this.ensureIndex();
		this.reconcileResources();
	}
	private showMore() {
		this.limit += 40;
		this.reconcileResources();
	}
	private async openFile(id: string, opener?: HTMLElement) {
		this.closeFile();
		this.previewId = id;
		this.opener = opener;
		this.opening = true;
		this.error = "";
		this.failures.delete(id);
		this.publish();
		const signal = AbortSignal.any([
			this.signal,
			this.previewController.signal,
		]);
		try {
			await this.chain.sync();
			signal.throwIfAborted();
			await this.view.file(id, signal);
			signal.throwIfAborted();
			this.reconcileResources();
			const resource = this.resources.get(id);
			if (!resource) {
				throw new Error("Preview is unavailable.");
			}
			await resource.media.reveal(signal);
			return true;
		} catch (error) {
			if (!signal.aborted) {
				this.failures.set(id, errorMessage(error));
				this.error = errorMessage(error);
				this.publish();
			}
			return false;
		} finally {
			if (!signal.aborted) {
				this.opening = false;
				this.publish();
			}
		}
	}
	private closeFile() {
		this.previewController.abort();
		this.previewController = new AbortController();
		if (this.previewId) {
			this.resources.get(this.previewId)?.media.close();
		}
		this.previewId = null;
		this.opener = undefined;
		this.opening = false;
		this.publish();
	}
	private editFile(id: string, patch: Metadata) {
		return this.mutateFile("metadata", id, patch);
	}
	private deleteFile(id: string) {
		return this.mutateFile("delete", id);
	}
	private restoreFile(id: string) {
		return this.mutateFile("restore", id);
	}
	private purgeFile(id: string) {
		return this.mutateFile("purge", id);
	}
	private writableFile(id: string) {
		const view = get(this.view);
		const file = view.selected?.files.get(id);
		if (
			this.readonlyView() ||
			!view.selected ||
			!file ||
			file.purged ||
			view.unavailable.has(id)
		) {
			throw new Error("Changes require an available file in the live view.");
		}
		return { file, expected: stateCheckpoint(view.selected) };
	}
	private async mutateFile(
		kind: "metadata" | "delete" | "restore" | "purge",
		id: string,
		patch?: Metadata,
	) {
		if (this.mutation || this.signal.aborted) {
			return false;
		}
		this.mutation = new AbortController();
		const signal = AbortSignal.any([this.signal, this.mutation.signal]);
		this.mutatingId = id;
		this.failures.delete(id);
		this.publish();
		try {
			const { file, expected } = this.writableFile(id);
			if (
				kind === "purge" &&
				!this.confirm(
					"Permanently delete this file's content, thumbnails, and every metadata version? This cannot be undone.",
				)
			) {
				return false;
			}
			if (kind === "metadata") {
				const draft = encode(patch ?? {});
				const previous = this.prepared.get(id);
				const change =
					previous && sameBytes(previous.draft, draft)
						? previous.change
						: await this.files.prepareEdit(
								file,
								patch ?? {},
								undefined,
								expected,
								signal,
							);
				this.prepared.set(id, { draft, change });
				await this.files.commit(change, signal);
				this.prepared.delete(id);
			} else {
				const operation =
					kind === "delete"
						? { kind: "DeleteFile" as const, id: file.id }
						: kind === "restore"
							? { kind: "RestoreFile" as const, id: file.id }
							: { kind: "PurgeFiles" as const, ids: [file.id] };
				await this.chain.append({
					expected,
					kind: "data",
					effects: kind === "purge" ? [["purge", [file.id]]] : [],
					plaintext: encodeOperation(operation),
					signal,
				});
			}
			await this.changed();
			return true;
		} catch (error) {
			if (!signal.aborted) {
				this.failures.set(id, errorMessage(error));
			}
			return false;
		} finally {
			this.mutation = null;
			this.mutatingId = null;
			this.publish();
		}
	}
	private async downloadFile(id: string) {
		if (this.signal.aborted || this.downloads.has(id)) {
			return false;
		}
		const controller = new AbortController();
		this.downloads.set(id, controller);
		const signal = AbortSignal.any([this.signal, controller.signal]);
		this.failures.delete(id);
		this.publish();
		try {
			const selected = await this.view.file(id, signal);
			const manifest = await this.files.manifest(selected.file, signal);
			signal.throwIfAborted();
			const source = new FileContentSource(
				this.files,
				selected.file,
				selected.metadata,
				manifest,
				signal,
			);
			await this.streams.download(
				source,
				(url) => {
					signal.throwIfAborted();
					return this.save(url, source.name);
				},
				signal,
			);
			return true;
		} catch (error) {
			if (!this.signal.aborted) {
				this.failures.set(id, errorMessage(error));
			}
			return false;
		} finally {
			this.downloads.delete(id);
			this.publish();
		}
	}
	private disposeLibrary() {
		if (this.signal.aborted && this.controller.signal.aborted) {
			return;
		}
		this.controller.abort();
		this.previewController.abort();
		this.mutation?.abort();
		for (const operation of this.downloads.values()) {
			operation.abort();
		}
		this.downloads.clear();
		for (const unsubscribe of this.subscriptions) {
			unsubscribe();
		}
		for (const resource of this.resources.values()) {
			resource.unsubscribe();
			resource.media.dispose();
		}
		this.resources.clear();
		this.prepared.clear();
		this.failures.clear();
	}
}
function saveDownload(url: string, name: string) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	anchor.click();
}
