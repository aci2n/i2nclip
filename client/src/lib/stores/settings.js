import { get, writable } from "svelte/store";

export function createSettings(
	session,
	platform,
	{ followServer = true } = {},
) {
	const initial = {
		mode: "create",
		libraryName: "Personal",
		authorizePassword: "",
		server: "",
		password: "",
		otc: "",
		authorizerLibraryId: "",
		restorePassword: "",
		recoveryFiles: undefined,
		feedback: { scope: "setup", text: "", error: false },
	};
	const state = writable(initial);
	let disposed = false;
	let running = false;
	let serverUrl;
	let libraryId,
		attempt = 0;
	const drafts = new Map();
	const unsubscribe = session.subscribe((value) => {
		if (value.libraryId !== libraryId) {
			if (libraryId) drafts.set(libraryId, get(state));
			libraryId = value.libraryId;
			attempt++;
			running = false;
			state.set({
				...initial,
				mode:
					value.pendingRegistration?.method ||
					(value.catalog?.length ? "authorize" : "create"),
				authorizerLibraryId:
					value.pendingRegistration?.authorizerLibraryId ||
					value.catalog?.[0]?.id ||
					"",
				libraryName: value.libraryName || "Personal",
				...drafts.get(libraryId),
				server: value.serverUrl,
			});
			serverUrl = value.serverUrl;
		}
		if (serverUrl !== value.serverUrl) {
			serverUrl = value.serverUrl;
			if (followServer || !get(state).server)
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
		const ownAttempt = ++attempt;
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
		if (ownAttempt !== attempt && scope !== "reset") return false;
		if (scope === "reset" && success) drafts.clear();
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
		resetDraft(overrides = {}) {
			attempt++;
			running = false;
			drafts.clear();
			state.set({ ...initial, server: get(session).serverUrl, ...overrides });
		},
		edit(field, value) {
			if (!disposed)
				state.update((current) => ({ ...current, [field]: value }));
		},
		create() {
			const {
				server,
				password,
				authorizePassword,
				otc,
				authorizerLibraryId,
				mode,
				libraryName,
			} = get(state);
			const authorizer = get(session).catalog?.find(
				(row) => row.id === authorizerLibraryId,
			);
			return action(
				"create",
				() =>
					session.create({
						serverUrl:
							mode === "authorize" ? authorizer?.serverUrl : server.trim(),
						password: mode === "authorize" ? authorizePassword : password,
						otc: mode === "authorize" ? "" : otc,
						authorizerLibraryId:
							mode === "authorize" ? authorizerLibraryId : undefined,
						libraryName,
					}),
				"Library created. Download your recovery file before uploading.",
				"Creating library…",
				{ password: "", authorizePassword: "", otc: "" },
			);
		},
		discardCreation() {
			if (
				disposed ||
				running ||
				get(session).busy ||
				!platform.confirm(
					"Discard this pending identity? Its invitation may already be used, and any library registered with this identity will become inaccessible.",
				)
			)
				return;
			return action(
				"create",
				session.discardCreation,
				"Pending creation discarded.",
				"Discarding…",
				{ password: "", otc: "" },
			);
		},
		restore() {
			const { recoveryFiles, restorePassword, libraryName } = get(state);
			return action(
				"restore",
				() => session.restore(recoveryFiles?.[0], restorePassword, libraryName),
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
