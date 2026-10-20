import { type Writable, writable } from "svelte/store";
import type { ViewerApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import {
	createMediaItem,
	type MediaItem,
	type MediaOptions,
	type MediaState,
} from "./media-item.ts";
import type { LibraryContext } from "./session.ts";

export interface ViewerState {
	media: MediaState | null;
	loading: boolean;
	error: string;
}
export function createMediaViewer(
	id: string,
	context: LibraryContext,
	options: Omit<MediaOptions, "http"> & { http?: ViewerApi } = {},
): Pick<MediaViewerStoreImpl, keyof MediaViewerStoreImpl> {
	return new MediaViewerStoreImpl(id, context, options);
}

class MediaViewerStoreImpl {
	private readonly id: string;
	private readonly context: LibraryContext;
	private readonly http: ViewerApi;
	private readonly options: Omit<MediaOptions, "http">;
	private readonly log: ReturnType<typeof createLog>;
	private readonly state: Writable<ViewerState>;
	private readonly controller: AbortController;
	private readonly signal: AbortSignal;
	private item: MediaItem | null;
	private unsubscribe?: () => void;
	private loading: boolean;

	readonly subscribe: Writable<ViewerState>["subscribe"];
	readonly retry = this.loadViewer.bind(this);
	readonly download = this.downloadCommand.bind(this);
	readonly dispose = this.disposeViewer.bind(this);

	constructor(
		id: string,
		context: LibraryContext,
		{
			http = api,
			...options
		}: Omit<MediaOptions, "http"> & { http?: ViewerApi } = {},
	) {
		this.id = id;
		this.context = context;
		this.http = http;
		this.options = options;
		this.log = createLog("media-viewer");
		const controller = new AbortController();
		this.state = writable<ViewerState>({
			media: null,
			loading: false,
			error: "",
		});
		this.subscribe = this.state.subscribe;
		this.controller = controller;
		this.signal = AbortSignal.any([controller.signal, context.signal]);
		this.item = null;
		this.loading = false;
		if (this.signal.aborted) {
			this.disposeViewer();
		} else {
			this.signal.addEventListener("abort", this.dispose, { once: true });
		}
	}

	private downloadCommand() {
		return this.item?.download() ?? Promise.resolve(false);
	}

	private async loadViewer() {
		if (this.signal.aborted || this.loading) {
			return false;
		}
		const operation = this.log.operation();
		this.log.debug("load-started", { operation });
		this.loading = true;
		this.state.update((value) => ({ ...value, loading: true, error: "" }));
		try {
			if (!/^[0-9a-f]{64}$/.test(this.id)) {
				throw new Error("Invalid media link.");
			}
			if (!this.item) {
				const media = await this.http.getMedia({
					...this.context,
					id: this.id,
					signal: this.signal,
				});
				this.signal.throwIfAborted();
				if (!media.metadata) {
					throw new Error("File metadata is unavailable.");
				}
				this.item = createMediaItem(media, this.context, {
					http: { ...api, ...this.http },
					...this.options,
				});
				this.unsubscribe = this.item.subscribe((media) =>
					this.state.update((value) => ({ ...value, media })),
				);
			}
			const ok = Boolean(await this.item.reveal(this.signal));
			this.log.debug(
				this.signal.aborted ? "load-cancelled" : "load-completed",
				{
					operation,
					ok,
				},
			);
			return ok;
		} catch (error) {
			if (this.signal.aborted) {
				this.log.debug("load-cancelled", { operation });
			} else {
				this.log.error("load-failed", { operation, ...failureFields(error) });
			}
			if (!this.signal.aborted) {
				const message =
					error &&
					typeof error === "object" &&
					"status" in error &&
					error.status === 404
						? "File not found in this library."
						: errorMessage(error);
				this.state.update((value) => ({ ...value, error: message }));
			}
			return false;
		} finally {
			this.loading = false;
			if (!this.signal.aborted) {
				this.state.update((value) => ({ ...value, loading: false }));
			}
		}
	}

	private disposeViewer() {
		this.log.debug("disposed");
		this.signal.removeEventListener("abort", this.dispose);
		this.controller.abort();
		this.unsubscribe?.();
		this.item?.dispose();
		this.item = null;
		this.state.set({ media: null, loading: false, error: "" });
	}
}
