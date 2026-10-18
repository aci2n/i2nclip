import { writable } from "svelte/store";
import { createLog, failureFields } from "../log.ts";
import {
	copyUploadOptions,
	defaultUploadOptions,
	type UploadOptions,
	validUploadOptions,
} from "../media/options.ts";
import { b64ToBytes, bytesToB64 } from "../protocol/bytes.ts";
import { decode, encode } from "../protocol/msgpack.ts";

export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}
const KEY = "i2nclip.media-upload-options";

export type Preferences = ReturnType<typeof createPreferences>;

export function createPreferences(
	storage: PreferenceStorage = globalThis.localStorage,
) {
	const log = createLog("preferences");
	let options = defaultUploadOptions();
	let error = "";
	try {
		const saved = storage.getItem(KEY);
		if (saved != null) {
			const value = decode(b64ToBytes(saved));
			if (!validUploadOptions(value)) {
				throw new Error("Invalid upload preference.");
			}
			options = copyUploadOptions(value);
		}
	} catch (failure) {
		log.warn("read-failed", failureFields(failure));
		error = "Unable to read upload preferences.";
	}
	log.debug("loaded", { ok: !error });
	const state = writable({ options, error });
	return {
		subscribe: state.subscribe,
		setOptions(value: UploadOptions) {
			try {
				if (!validUploadOptions(value)) {
					throw new Error("Invalid upload options.");
				}
				const options = copyUploadOptions(value);
				storage.setItem(KEY, bytesToB64(encode(options)));
				log.info("saved");
				state.set({ options, error: "" });
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
