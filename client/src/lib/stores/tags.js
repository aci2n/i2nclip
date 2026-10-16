import { get, writable } from "svelte/store";
import * as api from "../api.js";

const empty = () => ({ tags: [], loading: false, error: "", warning: "" });

// Application owns the catalog for the unlocked identity, independently of pages.
export function createTags(session, { http = api } = {}) {
	const state = writable(empty());
	let controller;
	let disposed = false;
	let epoch = session.epoch;
	let ready = false;
	async function refresh() {
		const value = get(session);
		if (disposed || !value.unlocked || !value.configured || value.busy) {
			return false;
		}
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
				state.update((v) => ({ ...v, loading: false, error: error.message }));
			}
			return false;
		}
	}
	const unsubscribe = session.subscribe((value) => {
		if (value.epoch !== epoch || !value.unlocked || !value.configured) {
			epoch = value.epoch;
			controller?.abort();
			state.set(empty());
			ready = false;
		}
		if (!ready && value.unlocked && value.configured && !value.busy) {
			ready = true;
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
