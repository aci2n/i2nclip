import { writable } from "svelte/store";
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

export function createTags(
	context: LibraryContext,
	{ http = api }: { http?: TagApi } = {},
) {
	const log = createLog("tags");
	const state = writable(empty());
	let controller: AbortController | undefined;
	let disposed = false;
	async function refresh() {
		if (disposed || context.signal.aborted) {
			return false;
		}
		controller?.abort();
		controller = new AbortController();
		const operation = log.operation();
		log.debug("refresh-started", { operation });
		const signal = AbortSignal.any([controller.signal, context.signal]);
		state.update((v) => ({ ...v, loading: true, error: "" }));
		try {
			const result = await http.getTags({ ...context, signal });
			if (signal.aborted) {
				log.debug("refresh-stale", { operation });
				return false;
			}
			log.debug("refresh-completed", { operation });
			if (result.invalid) {
				log.warn("partial-catalog", { operation, invalid: result.invalid });
			}
			state.set({
				tags: result.tags,
				loading: false,
				error: "",
				warning: result.invalid ? "Some tag suggestions are unavailable." : "",
			});
			return true;
		} catch (error) {
			if (signal.aborted) {
				log.debug("refresh-cancelled", { operation });
			} else {
				log.warn("refresh-failed", { operation, ...failureFields(error) });
			}
			if (!signal.aborted) {
				state.update((v) => ({
					...v,
					loading: false,
					error: errorMessage(error),
				}));
			}
			return false;
		}
	}
	void refresh();
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
