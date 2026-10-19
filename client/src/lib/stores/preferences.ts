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

interface PreferencesDependencies {
	storage: PreferenceStorage;
	log: ReturnType<typeof createLog>;
}
interface PreferencesRuntime {
	state: ReturnType<
		typeof writable<{ compressImages: boolean; error: string }>
	>;
}

export function createPreferences(
	storage: PreferenceStorage = globalThis.localStorage,
) {
	const deps: PreferencesDependencies = {
		storage,
		log: createLog("preferences"),
	};
	const runtime: PreferencesRuntime = {
		state: writable(readPreferences(deps)),
	};

	return {
		subscribe: runtime.state.subscribe,
		setCompression: setCompression.bind(null, deps, runtime),
	};
}

function setCompression(
	deps: PreferencesDependencies,
	runtime: PreferencesRuntime,
	value: boolean,
) {
	try {
		deps.storage.setItem(KEY, bytesToB64(encode(value)));
		deps.log.info("saved");
		runtime.state.set({ compressImages: value, error: "" });
	} catch (error) {
		deps.log.warn("save-failed", failureFields(error));
		runtime.state.update((current) => ({
			...current,
			error: "Unable to save upload preferences.",
		}));
	}
}

function readPreferences({ storage, log }: PreferencesDependencies) {
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
	return { compressImages, error };
}
