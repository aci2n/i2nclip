import { writable } from "svelte/store";
import type { ViewerApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
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

// One direct link owns one item; it never searches or paginates the library.
export function createMediaViewer(
	id: string,
	context: LibraryContext,
	{
		http = api,
		...options
	}: Omit<MediaOptions, "http"> & { http?: ViewerApi } = {},
) {
	const state = writable<ViewerState>({
		media: null,
		loading: false,
		error: "",
	});
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, context.signal]);
	let item: MediaItem | null = null;
	let unsubscribe: (() => void) | undefined;
	let loading = false;
	async function load() {
		if (signal.aborted || loading) {
			return false;
		}
		loading = true;
		state.update((value) => ({ ...value, loading: true, error: "" }));
		try {
			if (!/^[0-9a-f]{64}$/.test(id)) {
				throw new Error("Invalid media link.");
			}
			if (!item) {
				const media = await http.getMedia({ ...context, id, signal });
				signal.throwIfAborted();
				if (!media.metadata) {
					throw new Error("File metadata is unavailable.");
				}
				item = createMediaItem(media, context, {
					http: { ...api, ...http },
					...options,
				});
				unsubscribe = item.subscribe((media) =>
					state.update((value) => ({ ...value, media })),
				);
			}
			return Boolean(await item.reveal(signal));
		} catch (error) {
			if (!signal.aborted) {
				const message =
					error &&
					typeof error === "object" &&
					"status" in error &&
					error.status === 404
						? "File not found in this library."
						: errorMessage(error);
				state.update((value) => ({ ...value, error: message }));
			}
			return false;
		} finally {
			loading = false;
			if (!signal.aborted) {
				state.update((value) => ({ ...value, loading: false }));
			}
		}
	}
	function dispose() {
		signal.removeEventListener("abort", dispose);
		controller.abort();
		unsubscribe?.();
		item?.dispose();
		item = null;
		state.set({ media: null, loading: false, error: "" });
	}
	signal.addEventListener("abort", dispose, { once: true });
	void load();
	return {
		subscribe: state.subscribe,
		retry: load,
		download: () => item?.download() ?? Promise.resolve(false),
		dispose,
	};
}
