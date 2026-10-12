import { get, writable } from "svelte/store";

// A render projection and command facade. Only the service owns identity state.
export function createSession(client, platform) {
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
	const unsubscribe = client.subscribe((value) =>
		state.set({ ...value.session, error: localError || value.session.error }),
	);
	async function action(name, payload) {
		localError = "";
		try {
			await client.command(`identity.${name}`, payload);
			return true;
		} catch (error) {
			localError = error.message;
			state.update((value) => ({ ...value, error: localError }));
			return false;
		}
	}
	return {
		subscribe: state.subscribe,
		ready: client.ready,
		create: (payload) => action("create", payload),
		restore: (file, password) => action("restore", { file, password }),
		unlock: (password) => action("unlock", { password }),
		setServer: (serverUrl) => action("setServer", { serverUrl }),
		discardCreation: () => action("discardCreation"),
		reset: () => action("reset"),
		async backup() {
			const instance = get(client).instanceId;
			const epoch = get(client).session.epoch;
			const blob = await client.command("identity.backup");
			if (
				disposed ||
				get(client).instanceId !== instance ||
				get(client).session.epoch !== epoch
			)
				return false;
			const url = URL.createObjectURL(blob);
			try {
				await platform.download(url, "i2nclip-recovery.json");
				return true;
			} finally {
				setTimeout(() => URL.revokeObjectURL(url), 60_000);
			}
		},
		dispose() {
			disposed = true;
			unsubscribe();
		},
	};
}
