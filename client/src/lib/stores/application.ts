import { get, type Writable, writable } from "svelte/store";
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

interface ApplicationDependencies {
	session: ReturnType<typeof createSession>;
	preferences: ReturnType<typeof createPreferences>;
	routing: ReturnType<typeof createRouting>;
	log: ReturnType<typeof createLog>;
}
interface ApplicationRuntime {
	state: Writable<{
		workspace: Workspace | null;
		streams: ContentStreams | null;
	}>;
	workspace: Workspace | null;
	disposed: boolean;
	streamContext: LibraryContext | null;
	streams: ContentStreams | null;
}
interface ApplicationResources {
	stopSession: () => void;
	stopRouting: () => void;
	stopPreferences: () => void;
	pairing: ReturnType<typeof createPairing>;
	extension: ReturnType<typeof createExtensionReceiver>;
}

export function createApplication({
	session = createSession(),
	preferences = createPreferences(),
}: {
	session?: ReturnType<typeof createSession>;
	preferences?: ReturnType<typeof createPreferences>;
} = {}) {
	const log = createLog("application");
	log.debug("created");
	const deps: ApplicationDependencies = {
		session,
		preferences,
		routing: createRouting(),
		log,
	};
	const runtime: ApplicationRuntime = {
		state: writable<{
			workspace: Workspace | null;
			streams: ContentStreams | null;
		}>({ workspace: null, streams: null }),
		workspace: null,
		disposed: false,
		streamContext: null,
		streams: null,
	};
	const stopSession = deps.session.subscribe(() =>
		syncWorkspace(deps, runtime),
	);
	const stopRouting = deps.routing.subscribe(() =>
		syncWorkspace(deps, runtime),
	);
	const stopPreferences = deps.preferences.subscribe(() =>
		syncWorkspace(deps, runtime),
	);
	const pairing = createPairing(deps.session);
	const extension = createExtensionReceiver(
		deps.session,
		() => runtime.workspace?.uploads ?? null,
		() => openCaptureLibrary(deps, runtime),
	);
	const resources: ApplicationResources = {
		stopSession,
		stopRouting,
		stopPreferences,
		pairing,
		extension,
	};

	return {
		subscribe: runtime.state.subscribe,
		session: deps.session,
		preferences: deps.preferences,
		pairing,
		routing: deps.routing,
		canDropFiles: canDropFiles.bind(null, deps, runtime),
		dropFiles: dropFiles.bind(null, deps, runtime),
		dispose: () => disposeApplication(deps, runtime, resources),
	};
}

function syncWorkspace(
	deps: ApplicationDependencies,
	runtime: ApplicationRuntime,
) {
	const context = get(deps.session).context;
	if (runtime.streamContext !== context) {
		runtime.streams?.dispose();
		runtime.streamContext = context;
		runtime.streams = context ? createContentStreams(context.signal) : null;
	}
	if (runtime.workspace && runtime.workspace.context !== context) {
		deps.log.debug("workspace-ended", { reason: "context-changed" });
		runtime.workspace.dispose();
		runtime.workspace = null;
	}
	if (
		context &&
		!get(deps.preferences).loading &&
		get(deps.routing).workspace &&
		!runtime.workspace
	) {
		deps.log.debug("workspace-created");
		runtime.workspace = createWorkspace(
			context,
			deps.preferences,
			runtime.streams ?? undefined,
		);
	}
	runtime.state.set({ workspace: runtime.workspace, streams: runtime.streams });
}

function canDropFiles(
	deps: ApplicationDependencies,
	runtime: ApplicationRuntime,
) {
	return (
		!runtime.disposed &&
		deps.session.ready &&
		runtime.workspace !== null &&
		!get(runtime.workspace.uploads).uploading
	);
}

function dropFiles(
	deps: ApplicationDependencies,
	runtime: ApplicationRuntime,
	files: File[],
) {
	if (!files.length || !canDropFiles(deps, runtime) || !runtime.workspace) {
		deps.log.debug("drop-rejected", { count: files.length });
		return;
	}
	deps.routing.navigate({ page: "library" }, true);
	deps.log.info("drop-accepted", { count: files.length });
	void runtime.workspace.uploads.upload(files);
}

function disposeApplication(
	deps: ApplicationDependencies,
	runtime: ApplicationRuntime,
	resources: ApplicationResources,
) {
	if (runtime.disposed) {
		return;
	}
	deps.log.debug("disposed");
	runtime.disposed = true;
	resources.extension.dispose();
	resources.pairing.dispose();
	resources.stopSession();
	resources.stopRouting();
	resources.stopPreferences();
	deps.preferences.dispose();
	deps.routing.dispose();
	runtime.workspace?.dispose();
	runtime.workspace = null;
	runtime.state.set({ workspace: runtime.workspace, streams: runtime.streams });
	runtime.streams?.dispose();
	runtime.streams = null;
	deps.session.dispose();
}

function openCaptureLibrary(
	deps: ApplicationDependencies,
	runtime: ApplicationRuntime,
) {
	deps.routing.navigate({ page: "library" }, true);
	// A capture may resume within a session notification before queued routing
	// subscribers run. Ensure its uploads exist before returning to the receiver.
	syncWorkspace(deps, runtime);
}
