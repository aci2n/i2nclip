import { get, writable } from "svelte/store";
import type { Quota, QuotaApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import type { LibraryContext } from "./session.ts";

const empty = (): {
	value: Quota | null;
	loading: boolean;
	error: string;
} => ({ value: null, loading: false, error: "" });

// Settings owns this store; identity changes and navigation dispose pending reads.
export function createQuota(
	context: LibraryContext,
	{ http = api }: { http?: QuotaApi } = {},
) {
	const state = writable(empty());
	let controller: AbortController | undefined;
	let disposed = false;

	async function refresh() {
		if (disposed || get(state).loading || context.signal.aborted) {
			return false;
		}
		controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, context.signal]);
		state.set({ value: null, loading: true, error: "" });
		try {
			const quota = await http.getQuota({ ...context, signal });
			if (signal.aborted) {
				return false;
			}
			state.set({ value: quota, loading: false, error: "" });
			return true;
		} catch (error) {
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
			disposed = true;
			controller?.abort();
			state.set(empty());
		},
	};
}
