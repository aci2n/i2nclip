import { get, writable } from "svelte/store";
import { createLog } from "../log.ts";
import {
	type ContentStreams,
	createContentStreams,
} from "./content-streams.ts";
import { createExtensionReceiver } from "./extension.ts";
import { createPairing } from "./pairing.ts";
import { createPreferences } from "./preferences.ts";
import { createRouting } from "./routing.ts";
import type { LibraryContext } from "./session.ts";
import { createSession } from "./session.ts";
import { createWorkspace, type Workspace } from "./workspace.ts";

export function createApplication() {
	const log = createLog("application");
	log.debug("created");
	const session = createSession();
	const preferences = createPreferences();
	const routing = createRouting();
	const state = writable<{
		workspace: Workspace | null;
		streams: ContentStreams | null;
	}>({ workspace: null, streams: null });
	let workspace: Workspace | null = null;
	let disposed = false;
	let streamContext: LibraryContext | null = null;
	let streams: ContentStreams | null = null;

	function syncWorkspace() {
		const context = get(session).context;
		if (streamContext !== context) {
			streams?.dispose();
			streamContext = context;
			streams = context ? createContentStreams(context.signal) : null;
		}
		if (workspace && workspace.context !== context) {
			log.debug("workspace-ended", { reason: "context-changed" });
			workspace.dispose();
			workspace = null;
		}
		if (context && get(routing).workspace && !workspace) {
			log.debug("workspace-created");
			workspace = createWorkspace(context, preferences, streams ?? undefined);
		}
		state.set({ workspace, streams });
	}
	const stopSession = session.subscribe(syncWorkspace);
	const stopRouting = routing.subscribe(syncWorkspace);
	const pairing = createPairing(session);
	const extension = createExtensionReceiver(
		session,
		() => workspace?.uploads ?? null,
		() => {
			routing.navigate({ page: "library" }, true);
			// A pending capture can resume inside a session notification, before
			// queued routing subscribers run. Its uploads must exist immediately.
			syncWorkspace();
		},
	);
	function canDropFiles() {
		return (
			!disposed &&
			session.ready &&
			workspace !== null &&
			!get(workspace.uploads).uploading
		);
	}
	return {
		subscribe: state.subscribe,
		session,
		preferences,
		pairing,
		routing,
		canDropFiles,
		dropFiles(files: File[]) {
			if (!files.length || !canDropFiles() || !workspace) {
				log.debug("drop-rejected", { count: files.length });
				return;
			}
			routing.navigate({ page: "library" }, true);
			log.info("drop-accepted", { count: files.length });
			void workspace.uploads.upload(files);
		},
		dispose() {
			if (disposed) {
				return;
			}
			log.debug("disposed");
			disposed = true;
			extension.dispose();
			pairing.dispose();
			stopSession();
			stopRouting();
			routing.dispose();
			workspace?.dispose();
			workspace = null;
			state.set({ workspace, streams });
			streams?.dispose();
			streams = null;
			session.dispose();
		},
	};
}
