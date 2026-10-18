import { get, writable } from "svelte/store";
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

// Workspace owns this store; navigation preserves reads until its context ends.
export function createQuota(
	context: LibraryContext,
	{ http = api }: { http?: QuotaApi } = {},
) {
	const log = createLog("quota");
	const state = writable(empty());
	let controller: AbortController | undefined;
	let disposed = false;

	async function refresh() {
		if (disposed || get(state).loading || context.signal.aborted) {
			return false;
		}
		controller = new AbortController();
		const operation = log.operation();
		log.debug("refresh-started", { operation });
		const signal = AbortSignal.any([controller.signal, context.signal]);
		state.set({ value: null, loading: true, error: "" });
		try {
			const quota = await http.getQuota({ ...context, signal });
			if (signal.aborted) {
				log.debug("refresh-stale", { operation });
				return false;
			}
			log.debug("refresh-completed", { operation });
			state.set({ value: quota, loading: false, error: "" });
			return true;
		} catch (error) {
			if (signal.aborted) {
				log.debug("refresh-cancelled", { operation });
			} else {
				log.warn("refresh-failed", { operation, ...failureFields(error) });
			}
			if (!signal.aborted) {
				state.set({ value: null, loading: false, error: errorMessage(error) });
			}
			return false;
		}
	}
	return {
		subscribe: state.subscribe,
		refresh,
		dispose() {
			log.debug("disposed");
			disposed = true;
			controller?.abort();
			state.set(empty());
		},
	};
}
