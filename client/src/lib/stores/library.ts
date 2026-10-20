import { get, writable } from "svelte/store";
import type { LibraryApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { canPreview } from "../media/format.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { normalizeTag } from "../protocol/tags.ts";
import type { MediaItem, MediaOptions, MediaState } from "./media-item.ts";
import { createMediaItem } from "./media-item.ts";
import type { LibraryContext } from "./session.ts";
export interface LibraryState {
	cards: MediaState[];
	query: string[];
	searchDraft: string;
	next: string | null;
	loading: boolean;
	empty: "library" | "search" | null;
	status: string;
	selected: { id: string; opener?: HTMLElement } | null;
}
export interface LibraryOptions {
	http?: LibraryApi;
	mediaOptions?: MediaOptions;
	onChange?: () => void;
	confirm?: (message: string) => boolean;
}
// Keep the public contract structural, independent of private implementation fields.
export type Library = Pick<LibraryStore, keyof LibraryStore>;

interface LibraryCard {
	media: MediaItem;
	value: MediaState;
	unsubscribe: () => void;
}

export function createLibrary(
	context: LibraryContext,
	options: LibraryOptions = {},
): Library {
	return new LibraryStore(context, options);
}

class LibraryStore {
	private readonly state = writable<LibraryState>({
		cards: [],
		query: [],
		searchDraft: "",
		next: null,
		loading: false,
		empty: null,
		status: "",
		selected: null,
	});
	private readonly cards = new Map<string, LibraryCard>();
	private readonly log = createLog("library");
	private readonly context: LibraryContext;
	private readonly http: LibraryApi;
	private readonly mediaOptions: MediaOptions;
	private readonly onChange: () => void;
	private readonly confirm: (message: string) => boolean;
	private disposed = false;
	private searchController?: AbortController;
	private previewController: AbortController | null = null;

	constructor(
		context: LibraryContext,
		{
			http = api,
			mediaOptions = {},
			onChange = () => {},
			confirm = (message: string) => globalThis.confirm(message),
		}: LibraryOptions,
	) {
		this.context = context;
		this.http = http;
		this.mediaOptions = mediaOptions;
		this.onChange = onChange;
		this.confirm = confirm;
		void this.search();
	}

	readonly subscribe = this.state.subscribe;
	readonly editDraft = (searchDraft: string) =>
		this.state.update((v) => ({ ...v, searchDraft }));
	readonly addTag = (tag: string) =>
		this.search([...get(this.state).query, tag], { clearDraft: true });
	readonly removeTag = (tag: string) =>
		this.search(get(this.state).query.filter((existing) => existing !== tag));
	readonly clearSearch = () => this.search([], { clearDraft: true });
	readonly more = () => this.search(get(this.state).query, { more: true });
	readonly refresh = () => this.search(get(this.state).query);

	private publishCards() {
		this.state.update((v) => ({
			...v,
			cards: [...this.cards.values()].map((row) => row.value),
		}));
	}

	private clearCards() {
		for (const row of this.cards.values()) {
			row.unsubscribe();
			row.media.dispose();
		}
		this.cards.clear();
		this.publishCards();
	}

	private addCard(item: api.Media) {
		if (this.cards.has(item.id)) {
			return;
		}
		const media = createMediaItem(item, this.context, {
			http: this.http,
			...this.mediaOptions,
		});
		const row = { media, value: get(media), unsubscribe: () => {} };
		this.cards.set(item.id, row);
		row.unsubscribe = media.subscribe((value) => this.updateCard(row, value));
	}

	readonly closePreview = () => {
		this.previewController?.abort();
		this.previewController = null;
		this.state.update((v) => ({ ...v, selected: null }));
	};

	private reset() {
		this.closePreview();
		this.searchController?.abort();
		this.clearCards();
		this.state.update((v) => ({
			...v,
			next: null,
			loading: false,
			empty: null,
			status: "",
			selected: null,
			query: [],
			searchDraft: "",
		}));
	}

	readonly search = async (
		query = get(this.state).query,
		{ more = false, clearDraft = false } = {},
	) => {
		if (this.disposed || this.context.signal.aborted) {
			this.log.debug("search-rejected", { reason: "disposed" });
			return false;
		}
		const previous = get(this.state);
		if (more && (previous.loading || !previous.next)) {
			this.log.debug("search-rejected", {
				reason: previous.loading ? "busy" : "no-next-page",
			});
			return false;
		}
		let submitted: string[];
		try {
			submitted = submittedTags(more ? previous.query : query);
		} catch (error) {
			this.log.warn("search-invalid", failureFields(error));
			this.state.update((v) => ({ ...v, status: errorMessage(error) }));
			return false;
		}
		const operation = this.log.operation();
		this.log.debug("search-started", {
			operation,
			more,
			tagCount: submitted.length,
		});
		this.searchController?.abort();
		this.searchController = new AbortController();
		const signal = AbortSignal.any([
			this.searchController.signal,
			this.context.signal,
		]);
		if (!more) {
			this.closePreview();
			this.clearCards();
		}
		this.state.update((v) => ({
			...v,
			query: submitted,
			searchDraft: clearDraft ? "" : v.searchDraft,
			loading: true,
			empty: null,
			status: "",
			selected: more ? v.selected : null,
			next: more ? v.next : null,
		}));
		try {
			const page = await this.http.list({
				...this.context,
				tags: submitted,
				after: more ? previous.next : null,
				signal,
			});
			if (signal.aborted) {
				this.log.debug("search-stale", { operation });
				return false;
			}
			this.log.debug("search-completed", {
				operation,
				count: page.items.length,
				hasNext: Boolean(page.next),
			});
			for (const item of page.items) {
				this.addCard(item);
			}
			this.state.update((v) => ({
				...v,
				next: page.next,
				empty: this.cards.size ? null : submitted.length ? "search" : "library",
			}));
			return true;
		} catch (error) {
			if (signal.aborted) {
				this.log.debug("search-cancelled", { operation });
			} else {
				this.log.error("search-failed", { operation, ...failureFields(error) });
			}
			if (!signal.aborted) {
				this.state.update((v) => ({ ...v, status: errorMessage(error) }));
			}
			return false;
		} finally {
			if (!signal.aborted) {
				this.state.update((v) => ({ ...v, loading: false }));
			}
		}
	};

	readonly reveal = async (id: string, opener?: HTMLElement) => {
		const row = this.cards.get(id);
		if (
			!row ||
			row.value.busy ||
			row.value.deleted ||
			!canPreview(
				row.value.metadata?.content_type || "",
				row.value.metadata?.name || "",
			)
		) {
			return false;
		}
		this.previewController?.abort();
		this.previewController = new AbortController();
		this.state.update((v) => ({
			...v,
			selected: { id, opener: v.selected?.opener || opener },
		}));
		return row.media.reveal(this.previewController.signal).then(Boolean);
	};

	readonly download = async (id: string) => {
		const row = this.cards.get(id);
		return row ? row.media.download() : false;
	};

	readonly updateMetadata = async (id: string, patch: Metadata) => {
		const row = this.cards.get(id);
		if (!row) {
			return false;
		}
		const saved = await row.media.updateMetadata(patch);
		if (saved) {
			void this.onChange();
		}
		return saved;
	};

	readonly remove = async (id: string) => {
		const row = this.cards.get(id);
		if (
			!row ||
			row.value.busy ||
			row.value.deleted ||
			!this.confirm(
				`Delete ${row.value.metadata?.name || id}? This cannot be undone.`,
			)
		) {
			return false;
		}
		if (await row.media.remove()) {
			void this.onChange();
			this.closePreview();
			return true;
		}
		return false;
	};

	readonly dispose = () => {
		this.log.debug("disposed");
		this.disposed = true;
		this.reset();
	};

	private updateCard(row: LibraryCard, value: MediaState) {
		row.value = value;
		this.publishCards();
	}
}

function submittedTags(tags: string[]) {
	const seen = new Set<string>();
	const submitted: string[] = [];
	for (const tag of tags) {
		const normalized = normalizeTag(tag);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			submitted.push(tag.trim());
		}
	}
	if (submitted.length > 64) {
		throw new Error("Too many search tags (maximum 64).");
	}
	return submitted;
}
