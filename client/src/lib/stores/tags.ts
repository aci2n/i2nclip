import { get, writable } from "svelte/store";
import type { TagApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import type { SessionReader } from "./session.ts";

const empty = (): {
	tags: string[];
	loading: boolean;
	error: string;
	warning: string;
} => ({ tags: [], loading: false, error: "", warning: "" });

// Application owns the catalog for the unlocked identity, independently of pages.
export type Tags = ReturnType<typeof createTags>;

export function createTags(
	session: SessionReader,
	{ http = api }: { http?: TagApi } = {},
) {
	const state = writable(empty());
	let controller: AbortController | undefined;
	let disposed = false;
	let epoch = session.epoch;
	let refreshNeeded = true;
	async function refresh() {
		const value = get(session);
		if (disposed || !value.unlocked || !value.configured) {
			return false;
		}
		if (value.busy) {
			refreshNeeded = true;
			return false;
		}
		refreshNeeded = false;
		controller?.abort();
		controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, session.signal]);
		const current = () =>
			!disposed && !signal.aborted && epoch === session.epoch;
		state.update((v) => ({ ...v, loading: true, error: "" }));
		try {
			const result = await http.getTags({ ...session.credentials(), signal });
			if (!current()) {
				return false;
			}
			state.set({
				tags: result.tags,
				loading: false,
				error: "",
				warning: result.invalid ? "Some tag suggestions are unavailable." : "",
			});
			return true;
		} catch (error) {
			if (current()) {
				state.update((v) => ({
					...v,
					loading: false,
					error: errorMessage(error),
				}));
			}
			return false;
		}
	}
	const unsubscribe = session.subscribe((value) => {
		if (value.epoch !== epoch || !value.unlocked || !value.configured) {
			epoch = value.epoch;
			controller?.abort();
			state.set(empty());
			refreshNeeded = true;
		}
		if (refreshNeeded && value.unlocked && value.configured && !value.busy) {
			void refresh();
		}
	});
	return {
		subscribe: state.subscribe,
		refresh,
		dispose() {
			disposed = true;
			unsubscribe();
			controller?.abort();
			state.set(empty());
		},
	};
}
