import { get, writable } from "svelte/store";
import type { QuotaApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import type { SessionReader } from "./session.ts";

const empty = (): {
	value: Awaited<ReturnType<typeof api.getQuota>> | null;
	loading: boolean;
	error: string;
} => ({ value: null, loading: false, error: "" });

// Settings owns this store; identity changes and navigation dispose pending reads.
export function createQuota(
	session: SessionReader,
	{ http = api }: { http?: QuotaApi } = {},
) {
	const state = writable(empty());
	let controller: AbortController | undefined;
	let disposed = false;
	let epoch = session.epoch;
	const unsubscribe = session.subscribe((value) => {
		if (value.epoch !== epoch || !value.unlocked || !value.configured) {
			epoch = value.epoch;
			controller?.abort();
			state.set(empty());
		}
	});
	async function refresh() {
		const value = get(session);
		if (
			disposed ||
			get(state).loading ||
			!value.configured ||
			!value.unlocked ||
			value.busy
		) {
			return false;
		}
		controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, session.signal]);
		const own = session.epoch;
		const current = () => !disposed && !signal.aborted && own === session.epoch;
		state.set({ value: null, loading: true, error: "" });
		try {
			const quota = await http.getQuota({ ...session.credentials(), signal });
			if (!current()) {
				return false;
			}
			state.set({ value: quota, loading: false, error: "" });
			return true;
		} catch (error) {
			if (current()) {
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
			unsubscribe();
			state.set(empty());
		},
	};
}
