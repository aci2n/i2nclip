import { writable } from "svelte/store";
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

// One direct link owns one item; it never searches or paginates the library.
interface MediaViewerDependencies {
	id: string;
	context: LibraryContext;
	http: ViewerApi;
	options: Omit<MediaOptions, "http">;
	log: ReturnType<typeof createLog>;
}
interface MediaViewerRuntime {
	state: ReturnType<typeof writable<ViewerState>>;
	controller: AbortController;
	signal: AbortSignal;
	item: MediaItem | null;
	unsubscribe?: () => void;
	loading: boolean;
	dispose: () => void;
}

export function createMediaViewer(
	id: string,
	context: LibraryContext,
	{
		http = api,
		...options
	}: Omit<MediaOptions, "http"> & { http?: ViewerApi } = {},
) {
	const deps: MediaViewerDependencies = {
		id,
		context,
		http,
		options,
		log: createLog("media-viewer"),
	};
	const controller = new AbortController();
	const runtime: MediaViewerRuntime = {
		state: writable<ViewerState>({
			media: null,
			loading: false,
			error: "",
		}),
		controller,
		signal: AbortSignal.any([controller.signal, context.signal]),
		item: null,
		loading: false,
		dispose: () => disposeViewer(deps, runtime),
	};
	runtime.signal.addEventListener("abort", runtime.dispose, { once: true });
	void loadViewer(deps, runtime);

	return {
		subscribe: runtime.state.subscribe,
		retry: loadViewer.bind(null, deps, runtime),
		download: () => runtime.item?.download() ?? Promise.resolve(false),
		dispose: runtime.dispose,
	};
}

async function loadViewer(
	deps: MediaViewerDependencies,
	runtime: MediaViewerRuntime,
) {
	if (runtime.signal.aborted || runtime.loading) {
		return false;
	}
	const operation = deps.log.operation();
	deps.log.debug("load-started", { operation });
	runtime.loading = true;
	runtime.state.update((value) => ({ ...value, loading: true, error: "" }));
	try {
		if (!/^[0-9a-f]{64}$/.test(deps.id)) {
			throw new Error("Invalid media link.");
		}
		if (!runtime.item) {
			const media = await deps.http.getMedia({
				...deps.context,
				id: deps.id,
				signal: runtime.signal,
			});
			runtime.signal.throwIfAborted();
			if (!media.metadata) {
				throw new Error("File metadata is unavailable.");
			}
			runtime.item = createMediaItem(media, deps.context, {
				http: { ...api, ...deps.http },
				...deps.options,
			});
			runtime.unsubscribe = runtime.item.subscribe((media) =>
				runtime.state.update((value) => ({ ...value, media })),
			);
		}
		const ok = Boolean(await runtime.item.reveal(runtime.signal));
		deps.log.debug(
			runtime.signal.aborted ? "load-cancelled" : "load-completed",
			{
				operation,
				ok,
			},
		);
		return ok;
	} catch (error) {
		if (runtime.signal.aborted) {
			deps.log.debug("load-cancelled", { operation });
		} else {
			deps.log.error("load-failed", { operation, ...failureFields(error) });
		}
		if (!runtime.signal.aborted) {
			const message =
				error &&
				typeof error === "object" &&
				"status" in error &&
				error.status === 404
					? "File not found in this library."
					: errorMessage(error);
			runtime.state.update((value) => ({ ...value, error: message }));
		}
		return false;
	} finally {
		runtime.loading = false;
		if (!runtime.signal.aborted) {
			runtime.state.update((value) => ({ ...value, loading: false }));
		}
	}
}

function disposeViewer(
	deps: MediaViewerDependencies,
	runtime: MediaViewerRuntime,
) {
	deps.log.debug("disposed");
	runtime.signal.removeEventListener("abort", runtime.dispose);
	runtime.controller.abort();
	runtime.unsubscribe?.();
	runtime.item?.dispose();
	runtime.item = null;
	runtime.state.set({ media: null, loading: false, error: "" });
}
