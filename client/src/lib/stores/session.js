import { get, writable } from "svelte/store";

// A render projection and command facade. Only the service owns identity state.
export function createSession(client) {
	const state = writable({
		ready: false,
		configured: false,
		unlocked: false,
		serverUrl: "",
		busy: false,
		error: "",
		pendingRegistration: null,
	});
	let disposed = false;
	let localError = "";
	let libraryId;
	const unsubscribe = client.subscribe((value) => {
		if (libraryId !== value.libraryId) {
			localError = "";
			libraryId = value.libraryId;
		}
		state.set({
			...value.session,
			catalog: value.catalog || [],
			libraryId: value.libraryId,
			libraryName: value.libraryName,
			error: localError || value.session.error,
		});
	});
	async function action(name, payload) {
		const ownLibrary = get(client).libraryId;
		localError = "";
		try {
			await client.command(`identity.${name}`, payload);
			return true;
		} catch (error) {
			if (disposed || get(client).libraryId !== ownLibrary) {
				return false;
			}
			localError = error.message;
			state.update((value) => ({ ...value, error: localError }));
			return false;
		}
	}
	async function renameForSetup(name) {
		if (name === undefined || !client.rootCommand) {
			return;
		}
		const captured = get(client);
		if (!captured.libraryId) {
			return;
		}
		await client.rootCommand("libraries.rename", {
			libraryId: captured.libraryId,
			name,
		});
		const latest = get(client);
		if (
			latest.libraryId !== captured.libraryId ||
			latest.instanceId !== captured.instanceId ||
			latest.session.epoch !== captured.session.epoch
		) {
			throw new Error("Library changed. Start setup again.");
		}
	}
	return {
		subscribe: state.subscribe,
		ready: client.ready,
		create: async (payload) => {
			await renameForSetup(payload.libraryName);
			return action("create", payload);
		},
		setServer: (serverUrl) => action("setServer", { serverUrl }),
		discardCreation: () => action("discardCreation"),
		dispose() {
			disposed = true;
			unsubscribe();
		},
	};
}
