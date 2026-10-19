import { type Writable, writable } from "svelte/store";
import type { TagApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import type { LibraryContext } from "./session.ts";

const empty = (): {
	tags: string[];
	loading: boolean;
	error: string;
	warning: string;
} => ({ tags: [], loading: false, error: "", warning: "" });

// Application owns the catalog for the unlocked identity, independently of pages.
export type Tags = ReturnType<typeof createTags>;

interface TagsDependencies {
	context: LibraryContext;
	http: TagApi;
	log: ReturnType<typeof createLog>;
}
interface TagsRuntime {
	state: Writable<ReturnType<typeof empty>>;
	controller?: AbortController;
	disposed: boolean;
}

export function createTags(
	context: LibraryContext,
	{ http = api }: { http?: TagApi } = {},
) {
	const deps: TagsDependencies = { context, http, log: createLog("tags") };
	const runtime: TagsRuntime = { state: writable(empty()), disposed: false };
	void refreshTags(deps, runtime);

	return {
		subscribe: runtime.state.subscribe,
		refresh: refreshTags.bind(null, deps, runtime),
		dispose: disposeTags.bind(null, deps, runtime),
	};
}

async function refreshTags(deps: TagsDependencies, runtime: TagsRuntime) {
	if (runtime.disposed || deps.context.signal.aborted) {
		return false;
	}
	runtime.controller?.abort();
	runtime.controller = new AbortController();
	const operation = deps.log.operation();
	deps.log.debug("refresh-started", { operation });
	const signal = AbortSignal.any([
		runtime.controller.signal,
		deps.context.signal,
	]);
	runtime.state.update((v) => ({ ...v, loading: true, error: "" }));
	try {
		const result = await deps.http.getTags({ ...deps.context, signal });
		if (signal.aborted) {
			deps.log.debug("refresh-stale", { operation });
			return false;
		}
		deps.log.debug("refresh-completed", { operation });
		if (result.invalid) {
			deps.log.warn("partial-catalog", { operation, invalid: result.invalid });
		}
		runtime.state.set({
			tags: result.tags,
			loading: false,
			error: "",
			warning: result.invalid ? "Some tag suggestions are unavailable." : "",
		});
		return true;
	} catch (error) {
		if (signal.aborted) {
			deps.log.debug("refresh-cancelled", { operation });
		} else {
			deps.log.warn("refresh-failed", { operation, ...failureFields(error) });
		}
		if (!signal.aborted) {
			runtime.state.update((v) => ({
				...v,
				loading: false,
				error: errorMessage(error),
			}));
		}
		return false;
	}
}

function disposeTags(deps: TagsDependencies, runtime: TagsRuntime) {
	deps.log.debug("disposed");
	runtime.disposed = true;
	runtime.controller?.abort();
	runtime.state.set(empty());
}
