import { writable } from "svelte/store";
import { createLog, failureFields } from "../log.ts";
import { b64ToBytes, bytesToB64 } from "../protocol/bytes.ts";
import { decode, encode } from "../protocol/msgpack.ts";

export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}
const KEY = "i2nclip.compress-images";

export type Preferences = ReturnType<typeof createPreferences>;

export function createPreferences(
	storage: PreferenceStorage = globalThis.localStorage,
) {
	const log = createLog("preferences");
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
	} catch (failure) {
		log.warn("read-failed", failureFields(failure));
		error = "Unable to read upload preferences.";
	}
	log.debug("loaded", { ok: !error });
	const state = writable({ compressImages, error });
	return {
		subscribe: state.subscribe,
		setCompression(value: boolean) {
			try {
				storage.setItem(KEY, bytesToB64(encode(value)));
				log.info("saved");
				state.set({ compressImages: value, error: "" });
			} catch (error) {
				log.warn("save-failed", failureFields(error));
				state.update((current) => ({
					...current,
					error: "Unable to save upload preferences.",
				}));
			}
		},
	};
}
