import { get, writable } from "svelte/store";

export function createSettings(session, platform) {
	const initial = {
		mode: "create",
		server: "",
		password: "",
		otc: "",
		restorePassword: "",
		recoveryFiles: undefined,
		feedback: { scope: "setup", text: "", error: false },
	};
	const state = writable(initial);
	let disposed = false;
	let running = false;
	let serverUrl;
	const unsubscribe = session.subscribe((value) => {
		if (serverUrl !== value.serverUrl) {
			serverUrl = value.serverUrl;
			state.update((current) => ({ ...current, server: serverUrl }));
		}
	});
	async function action(
		scope,
		task,
		message,
		pending = "Working…",
		clear = {},
	) {
		if (disposed || running || get(session).busy) return false;
		running = true;
		state.update((value) => ({
			...value,
			feedback: { scope, text: pending, error: false },
		}));
		let success = false;
		let error;
		try {
			success = await task();
		} catch (failure) {
			error = failure.message;
		}
		running = false;
		if (disposed) return false;
		state.update((value) => ({
			...value,
			...(success ? clear : {}),
			feedback: {
				scope,
				text: success ? message : error || get(session).error,
				error: !success,
			},
		}));
		return success;
	}
	return {
		subscribe: state.subscribe,
		edit(field, value) {
			if (!disposed)
				state.update((current) => ({ ...current, [field]: value }));
		},
		create() {
			const { server, password, otc } = get(state);
			return action(
				"create",
				() => session.create({ serverUrl: server.trim(), password, otc }),
				"Library created. Download your recovery file before uploading.",
				"Creating library…",
				{ password: "", otc: "" },
			);
		},
		restore() {
			const { recoveryFiles, restorePassword } = get(state);
			return action(
				"restore",
				() => session.restore(recoveryFiles?.[0], restorePassword),
				"Library restored and unlocked.",
				"Restoring library…",
				{ restorePassword: "", recoveryFiles: undefined },
			);
		},
		backup: () =>
			action(
				"backup",
				session.backup,
				"Recovery download started. Keep the file and your password somewhere safe.",
			),
		setServer: () =>
			action(
				"server",
				() => session.setServer(get(state).server.trim()),
				"Server URL updated.",
			),
		reset() {
			if (
				disposed ||
				get(session).busy ||
				running ||
				!platform.confirm(
					"Reset everything in this browser? Keep a recovery file first. Uploads on the server will stay saved.",
				)
			)
				return;
			return action(
				"reset",
				session.reset,
				"Browser settings reset. Create a library or restore from a recovery file.",
				"Working…",
				{
					mode: "create",
					password: "",
					otc: "",
					restorePassword: "",
					recoveryFiles: undefined,
				},
			);
		},
		dispose() {
			disposed = true;
			unsubscribe();
		},
	};
}
