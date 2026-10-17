import { writable } from "svelte/store";
import { b64ToBytes, bytesToB64 } from "../protocol/bytes.ts";
import { decode, encode } from "../protocol/msgpack.ts";

export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}
const KEY = "i2nclip.compress-images";

export function createPreferences(
	storage: PreferenceStorage = globalThis.localStorage,
) {
	let compressImages = true;
	let error = "";
	try {
		const saved = storage.getItem(KEY);
		if (saved != null) {
			const value = decode(b64ToBytes(saved));
			if (typeof value !== "boolean") {
				throw new Error("Invalid upload preference.");
			}
			compressImages = value;
		}
	} catch {
		error = "Unable to read upload preferences.";
	}
	const state = writable({ compressImages, error });
	return {
		subscribe: state.subscribe,
		setCompression(value: boolean) {
			try {
				storage.setItem(KEY, bytesToB64(encode(value)));
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
