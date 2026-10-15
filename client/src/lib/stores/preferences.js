import { writable } from "svelte/store";

const KEY = "i2nclip.compress-images";

export function createPreferences(storage = globalThis.localStorage) {
	let compressImages = true;
	let error = "";
	try {
		compressImages = storage.getItem(KEY) !== "false";
	} catch {
		error = "Unable to read upload preferences.";
	}
	const state = writable({ compressImages, error });
	return {
		subscribe: state.subscribe,
		setCompression(value) {
			try {
				storage.setItem(KEY, String(value));
				state.set({ compressImages: value, error: "" });
			} catch {
				state.update((current) => ({
					...current,
					error: "Unable to save upload preferences.",
				}));
			}
		},
	};
}
