import { writable } from "svelte/store";
import { createDatabase, type Database } from "../database.ts";
import { createLog, failureFields } from "../log.ts";

const KEY = "compressImages";
export type Preferences = ReturnType<typeof createPreferences>;

export function createPreferences(database: Database = createDatabase()) {
	const log = createLog("preferences");
	const state = writable({
		compressImages: true,
		error: "",
		loading: true,
		busy: false,
	});
	const controller = new AbortController();
	let busy = false;
	const loaded = load();
	async function load() {
		try {
			const value = await database.read<unknown>(KEY, controller.signal);
			controller.signal.throwIfAborted();
			if (value !== undefined && typeof value !== "boolean") {
				throw new Error("Invalid upload preference.");
			}
			state.set({
				compressImages: value ?? true,
				error: "",
				loading: false,
				busy: false,
			});
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}
			log.warn("read-failed", failureFields(error));
			state.update((value) => ({
				...value,
				loading: false,
				error: "Unable to read upload preferences. Using default compression.",
			}));
		}
	}
	return {
		subscribe: state.subscribe,
		loaded,
		async setCompression(value: boolean) {
			if (busy || controller.signal.aborted) {
				return;
			}
			busy = true;
			await loaded;
			if (controller.signal.aborted) {
				return;
			}
			state.update((current) => ({ ...current, busy: true, error: "" }));
			try {
				await database.update<boolean>(KEY, () => value, controller.signal);
				controller.signal.throwIfAborted();
				state.update((current) => ({ ...current, compressImages: value }));
			} catch (error) {
				if (controller.signal.aborted) {
					return;
				}
				log.warn("save-failed", failureFields(error));
				state.update((current) => ({
					...current,
					error: "Unable to save upload preferences.",
				}));
			} finally {
				busy = false;
				if (!controller.signal.aborted) {
					state.update((current) => ({ ...current, busy: false }));
				}
			}
		},
		dispose() {
			controller.abort();
			database.dispose();
		},
	};
}
