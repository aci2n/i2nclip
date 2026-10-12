import { get, writable } from "svelte/store";
import { eligibleAuthorizers } from "./authorizers.js";
import { defaultLibraryName } from "./library-name.js";
import { createPairing } from "./pairing.js";
import { createSession } from "./session.js";
import { createSettings } from "./settings.js";

// Form fields belong to this page; only a submitted action allocates owner state.
export function createSetup(root, platform, currentLibrary, onComplete) {
	let id;
	let submitting;
	let generation = 0;
	let disposed = false;
	let opened = false;
	let lastPairing;
	let draftLibrary;
	const state = writable({ open: false });
	const projection = writable({
		session: {},
		pairing: { active: false },
		catalog: [],
	});
	let settings;
	function publish(value = get(root)) {
		const catalog = (value.catalog || []).map((row) => ({
			...row,
			...value.libraries?.[row.id]?.session,
			pairingActive: Boolean(value.libraries?.[row.id]?.pairing.active),
		}));
		const scoped = id && value.setup?.id === id ? value.setup : null;
		projection.set({
			...scoped,
			connected: value.connected,
			instanceId: `${value.instanceId}:${generation}`,
			libraryId: `draft:${generation}`,
			selectedLibraryId: currentLibrary(),
			catalog,
			pairing: scoped?.pairing || lastPairing || { active: false, status: "" },
			session: scoped?.session || {
				ready: value.connected,
				configured: false,
				unlocked: false,
				busy: false,
				error: "",
				epoch: 0,
				serverUrl:
					value.libraries?.[currentLibrary()]?.session.serverUrl ||
					value.defaultServerUrl ||
					"",
			},
		});
	}
	function close() {
		generation++;
		lastPairing = null;
		opened = false;
		id = undefined;
		submitting = undefined;
		state.set({ open: false });
		publish();
		settings?.resetDraft({
			libraryName: "",
			server: "",
			pairServer: "",
			otc: "",
		});
		void root.command("setup.close").catch(() => {});
	}
	const unsubscribe = root.subscribe((value) => {
		if (
			opened &&
			(!value.connected ||
				(value.vault && value.vault.status !== "unlocked") ||
				(draftLibrary &&
					(!value.libraries?.[draftLibrary] ||
						currentLibrary() !== draftLibrary)))
		) {
			close();
		}
		publish(value);
	});
	const adapter = {
		subscribe: projection.subscribe,
		ready: root.ready,
		async command(name, payload = {}, options) {
			if (!opened) {
				start();
			}
			const captured = generation;
			if (!id && !["identity.create", "pairing.receive"].includes(name)) {
				return true;
			}
			if (!id) {
				if (submitting === captured) {
					throw new Error("Setup is busy. Try again.");
				}
				submitting = captured;
				try {
					const draft = get(settings);
					const value = await root.command("setup.open", {
						name: draft.libraryName,
						method: name === "pairing.receive" ? "pair" : draft.mode,
						serverUrl: payload.serverUrl || draft.server,
						authorizerLibraryId: draft.authorizerLibraryId,
					});
					if (captured !== generation || disposed) {
						throw new Error("Setup context ended. Try again.");
					}
					id = value;
					publish();
				} finally {
					if (submitting === captured) {
						submitting = undefined;
					}
				}
			}
			let result;
			try {
				result = await root.command(name, { ...payload, setupId: id }, options);
			} catch (error) {
				if (captured === generation) {
					id = undefined;
					void root.command("setup.close").catch(() => {});
				}
				throw error;
			}
			if (captured !== generation || disposed) {
				return false;
			}
			if (
				result?.outcome &&
				get(root).libraries?.[result.libraryId]?.session.configured
			) {
				close();
				onComplete(result.libraryId, result.outcome, name, result.confirmation);
			} else if (name === "identity.create" || name === "pairing.receive") {
				// Retry with a fresh owner workflow and current form fields.
				lastPairing = get(projection).pairing;
				id = undefined;
				void root.command("setup.close").catch(() => {});
			}
			return result;
		},
	};
	const session = createSession(adapter);
	settings = createSettings(session, platform, { followServer: false });
	const pairing = createPairing(adapter);
	function start() {
		if (opened) {
			return;
		}
		lastPairing = null;
		draftLibrary = currentLibrary();
		opened = true;
		generation++;
		publish();
		const catalog = get(projection).catalog;
		const eligible = eligibleAuthorizers(catalog);
		settings.resetDraft({
			libraryName: defaultLibraryName(catalog),
			server: get(projection).session.serverUrl,
			pairServer: "",
			otc: "",
			mode: eligible.length ? "authorize" : "create",
			authorizerLibraryId:
				eligible.find((row) => row.id === currentLibrary())?.id ||
				eligible[0]?.id ||
				"",
		});
		state.set({ open: true });
	}
	return {
		subscribe: state.subscribe,
		session,
		settings,
		pairing,
		start,
		close,
		dispose() {
			close();
			disposed = true;
			unsubscribe();
			pairing.dispose();
			settings.dispose();
			session.dispose();
		},
	};
}
