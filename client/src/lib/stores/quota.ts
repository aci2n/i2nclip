import { get, type Writable, writable } from "svelte/store";
import type { Quota, QuotaApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import type { LibraryContext } from "./session.ts";

const empty = (): {
	value: Quota | null;
	loading: boolean;
	error: string;
} => ({ value: null, loading: false, error: "" });

export type QuotaStore = ReturnType<typeof createQuota>;

interface QuotaDependencies {
	context: LibraryContext;
	http: QuotaApi;
	log: ReturnType<typeof createLog>;
}
interface QuotaRuntime {
	state: Writable<ReturnType<typeof empty>>;
	controller?: AbortController;
	disposed: boolean;
}

// Workspace owns this store; navigation preserves reads until its context ends.
export function createQuota(
	context: LibraryContext,
	{ http = api }: { http?: QuotaApi } = {},
) {
	const deps: QuotaDependencies = { context, http, log: createLog("quota") };
	const runtime: QuotaRuntime = { state: writable(empty()), disposed: false };

	return {
		subscribe: runtime.state.subscribe,
		refresh: refreshQuota.bind(null, deps, runtime),
		dispose: disposeQuota.bind(null, deps, runtime),
	};
}

async function refreshQuota(deps: QuotaDependencies, runtime: QuotaRuntime) {
	if (
		runtime.disposed ||
		get(runtime.state).loading ||
		deps.context.signal.aborted
	) {
		return false;
	}
	runtime.controller = new AbortController();
	const operation = deps.log.operation();
	deps.log.debug("refresh-started", { operation });
	const signal = AbortSignal.any([
		runtime.controller.signal,
		deps.context.signal,
	]);
	runtime.state.set({ value: null, loading: true, error: "" });
	try {
		const quota = await deps.http.getQuota({ ...deps.context, signal });
		if (signal.aborted) {
			deps.log.debug("refresh-stale", { operation });
			return false;
		}
		deps.log.debug("refresh-completed", { operation });
		runtime.state.set({ value: quota, loading: false, error: "" });
		return true;
	} catch (error) {
		if (signal.aborted) {
			deps.log.debug("refresh-cancelled", { operation });
		} else {
			deps.log.warn("refresh-failed", { operation, ...failureFields(error) });
		}
		if (!signal.aborted) {
			runtime.state.set({
				value: null,
				loading: false,
				error: errorMessage(error),
			});
		}
		return false;
	}
}

function disposeQuota(deps: QuotaDependencies, runtime: QuotaRuntime) {
	deps.log.debug("disposed");
	runtime.disposed = true;
	runtime.controller?.abort();
	runtime.state.set(empty());
}
