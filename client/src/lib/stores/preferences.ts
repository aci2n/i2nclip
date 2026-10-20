import { writable } from "svelte/store";
import { createDatabase, type Database } from "../database.ts";
import { createLog, failureFields } from "../log.ts";

const KEY = "compressImages";
export type Preferences = Pick<PreferencesStore, keyof PreferencesStore>;

export function createPreferences(
	database: Database = createDatabase(),
): Preferences {
	return new PreferencesStore(database);
}

class PreferencesStore {
	private readonly database: Database;
	private readonly log = createLog("preferences");
	private readonly state = writable({
		compressImages: true,
		error: "",
		loading: true,
		busy: false,
	});
	private readonly controller = new AbortController();
	private busy = false;
	private initialLoad?: Promise<void>;

	readonly subscribe = this.state.subscribe;
	readonly load = this.loadPreferences.bind(this);
	readonly setCompression = this.saveCompression.bind(this);
	readonly dispose = this.disposePreferences.bind(this);

	constructor(database: Database) {
		this.database = database;
	}

	private loadPreferences() {
		this.initialLoad ??= this.readPreferences();
		return this.initialLoad;
	}

	private async readPreferences() {
		if (this.controller.signal.aborted) {
			return;
		}
		try {
			const value = await this.database.read<unknown>(
				KEY,
				this.controller.signal,
			);
			this.controller.signal.throwIfAborted();
			if (value !== undefined && typeof value !== "boolean") {
				throw new Error("Invalid upload preference.");
			}
			this.state.set({
				compressImages: value ?? true,
				error: "",
				loading: false,
				busy: false,
			});
		} catch (error) {
			if (this.controller.signal.aborted) {
				return;
			}
			this.log.warn("read-failed", failureFields(error));
			this.state.update((value) => ({
				...value,
				loading: false,
				error: "Unable to read upload preferences. Using default compression.",
			}));
		}
	}

	private async saveCompression(value: boolean) {
		if (this.busy || this.controller.signal.aborted) {
			return;
		}
		this.busy = true;
		await this.initialLoad;
		if (this.controller.signal.aborted) {
			return;
		}
		this.state.update((current) => ({ ...current, busy: true, error: "" }));
		try {
			await this.database.update<boolean>(
				KEY,
				() => value,
				this.controller.signal,
			);
			this.controller.signal.throwIfAborted();
			this.state.update((current) => ({ ...current, compressImages: value }));
		} catch (error) {
			if (this.controller.signal.aborted) {
				return;
			}
			this.log.warn("save-failed", failureFields(error));
			this.state.update((current) => ({
				...current,
				error: "Unable to save upload preferences.",
			}));
		} finally {
			this.busy = false;
			if (!this.controller.signal.aborted) {
				this.state.update((current) => ({ ...current, busy: false }));
			}
		}
	}

	private disposePreferences() {
		this.controller.abort();
		this.database.dispose();
	}
}
