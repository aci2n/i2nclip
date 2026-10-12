import { defaultLibraryName } from "./library-name.js";
import { get, writable } from "svelte/store";
import { createSession } from "./session.js";
import { createSettings } from "./settings.js";
import { createPairing } from "./pairing.js";

// A local form draft backed by an owner runtime only after submission.
export function createSetup(root, platform, currentLibrary, onComplete) {
	let id,
		starting,
		draftStarted = false,
		disposed = false,
		promoted = false;
	let wasUnlocked = false;
	const state = writable({ open: false, id: null, resumable: [] });
	const projection = writable({
		connected: false,
		libraryId: "draft",
		libraryName: "",
		session: {
			ready: false,
			configured: false,
			unlocked: false,
			serverUrl: "",
			epoch: 0,
		},
		catalog: [],
		pairing: { active: false },
		uploads: [],
		media: {},
		views: {},
	});
	function publish(value = get(root)) {
		const isUnlocked = !value.vault || value.vault.status === "unlocked";
		if (wasUnlocked && !isUnlocked) {
			id = undefined;
			draftStarted = false;
			promoted = false;
			settings.resetDraft({ libraryName: "", server: "" });
			state.update((v) => ({ ...v, open: false }));
		}
		wasUnlocked = isUnlocked;
		const source = value.libraries?.[currentLibrary()];
		if (id && value.connected && !value.libraries?.[id] && !starting) {
			id = undefined;
			draftStarted = false;
			promoted = false;
			settings.resetDraft({
				libraryName: "",
				server: source?.session.serverUrl || "",
				mode: value.catalog.length ? "authorize" : "create",
			});
			state.update((v) => ({ ...v, open: false }));
		}
		const scoped = promoted ? null : value.libraries?.[id];
		projection.set({
			...get(projection),
			...(scoped || {}),
			uploads: scoped?.uploads || [],
			media: scoped?.media || {},
			views: scoped?.views || {},
			pairing: scoped?.pairing || { active: false, status: "" },
			connected: value.connected,
			libraryId: "draft",
			libraryName: id ? value.setups?.find((row) => row.id === id)?.name : "",
			instanceId: value.instanceId,
			session: scoped?.session || {
				ready: Boolean(value.connected),
				configured: false,
				unlocked: false,
				serverUrl: source?.session.serverUrl || "",
				epoch: 0,
				busy: false,
				error: "",
			},
			catalog: (value.catalog || []).map((row) => ({
				...row,
				...value.libraries[row.id]?.session,
			})),
		});
		state.update((v) => ({
			...v,
			id,
			resumable: (value.setups || []).filter(
				(row) => row.id !== currentLibrary(),
			),
		}));
		if (id && scoped?.session.configured && !promoted) {
			const completedId = id;
			promoted = true;
			state.update((v) => ({ ...v, open: false }));
			queueMicrotask(() => {
				if (!disposed && promoted && id === completedId)
					onComplete(completedId);
			});
		}
	}
	const unsubscribe = root.subscribe(publish);
	const adapter = {
		subscribe: projection.subscribe,
		ready: root.ready,
		async command(name, payload = {}, options) {
			if (!id && !["identity.create", "pairing.receive"].includes(name))
				return true;
			if (!id) {
				const captured = get(root);
				starting ||= root
					.command("libraries.beginSetup", {
						name: get(settings).libraryName,
						method: get(settings).mode,
						serverUrl: payload.serverUrl || get(settings).server,
						authorizerLibraryId: get(settings).authorizerLibraryId,
					})
					.then((value) => {
						const latest = get(root);
						if (
							disposed ||
							latest.instanceId !== captured.instanceId ||
							latest.vault?.epoch !== captured.vault?.epoch ||
							(latest.vault && latest.vault.status !== "unlocked")
						)
							throw new Error("Vault context ended. Try again.");
						id = value;
						publish();
						return id;
					})
					.finally(() => {
						starting = null;
					});
				await starting;
			}
			const snapshot = get(root).libraries[id];
			return root.command(
				name,
				{
					...payload,
					libraryId: id,
					epoch: snapshot?.session.epoch,
					runtimeId: snapshot?.runtimeId,
				},
				options,
			);
		},
	};
	const session = createSession(adapter, platform);
	const settings = createSettings(session, platform, { followServer: false });
	const pairing = createPairing(adapter);
	function start() {
		if (!draftStarted || promoted) {
			draftStarted = true;
			id = undefined;
			promoted = false;
			publish();
			const catalog = get(projection).catalog;
			settings.edit("mode", catalog.length ? "authorize" : "create");
			settings.edit("libraryName", defaultLibraryName(catalog));
			settings.edit(
				"server",
				get(root).libraries[currentLibrary()]?.session.serverUrl || "",
			);
			settings.edit("pairServer", "");
			settings.edit("otc", "");
			settings.edit("feedback", { scope: "setup", text: "", error: false });
			settings.edit(
				"authorizerLibraryId",
				catalog.find((row) => row.id === currentLibrary())?.id ||
					catalog[0]?.id ||
					"",
			);
		}
		state.update((v) => ({ ...v, open: true }));
	}
	return {
		subscribe: state.subscribe,
		session,
		settings,
		pairing,
		start,
		resume(value) {
			const row = get(root).setups.find((row) => row.id === value);
			if (!row) return;
			draftStarted = true;
			id = value;
			promoted = false;
			publish();
			settings.edit("libraryName", row.name);
			const pending = get(root).libraries[id].session.pendingRegistration;
			settings.edit("mode", pending?.method || row.setup?.method || "create");
			settings.edit(
				"authorizerLibraryId",
				pending?.authorizerLibraryId || row.setup?.authorizerLibraryId || "",
			);
			settings.edit("server", get(root).libraries[id].session.serverUrl);
			state.update((v) => ({ ...v, open: true }));
		},
		close() {
			state.update((v) => ({ ...v, open: false }));
		},
		async discard() {
			try {
				if (promoted) return;
				if (
					id &&
					!platform.confirm(
						"Discard this unfinished setup? Its invitation may already be used. A registered library without its recovery key may become inaccessible.",
					)
				)
					return;
				if (id) await pairing.cancel();
				if (id) await root.command("libraries.discardSetup", { libraryId: id });
				id = undefined;
				draftStarted = false;
				promoted = false;
				publish();
				state.update((v) => ({ ...v, open: false }));
			} catch (error) {
				settings.edit("feedback", {
					scope: "setup",
					text: error.message,
					error: true,
				});
			}
		},
		dispose() {
			disposed = true;
			unsubscribe();
			pairing.dispose();
			settings.dispose();
			session.dispose();
		},
	};
}
