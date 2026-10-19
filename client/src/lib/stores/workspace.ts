import { createLog } from "../log.ts";
import type { ContentStreams } from "./content-streams.ts";
import { createLibrary } from "./library.ts";
import type { Preferences } from "./preferences.ts";
import { createQuota } from "./quota.ts";
import type { LibraryContext } from "./session.ts";
import { createTags } from "./tags.ts";
import { createUploads } from "./uploads.ts";

interface WorkspaceResources {
	quota: ReturnType<typeof createQuota>;
	tags: ReturnType<typeof createTags>;
	library: ReturnType<typeof createLibrary>;
	uploads: ReturnType<typeof createUploads>;
}

// One owner replaces all library state when its fixed identity context ends.
export function createWorkspace(
	context: LibraryContext,
	preferences: Preferences,
	streams?: ContentStreams,
) {
	const log = createLog("workspace");
	log.debug("created");
	const quota = createQuota(context);
	void quota.refresh();
	const tags = createTags(context);
	const library = createLibrary(context, {
		onChange: tags.refresh,
		mediaOptions: { streams },
	});
	const uploads = createUploads(context, {
		preferences,
		onComplete: () => uploadsCompleted(tags, library),
	});
	const resources: WorkspaceResources = { quota, tags, library, uploads };
	const dispose = () =>
		disposeWorkspace(context.signal, log, resources, dispose);
	context.signal.addEventListener("abort", dispose, { once: true });
	return { context, ...resources, dispose };
}
export type Workspace = ReturnType<typeof createWorkspace>;

function uploadsCompleted(
	tags: WorkspaceResources["tags"],
	library: WorkspaceResources["library"],
) {
	void tags.refresh();
	return library.refresh();
}

function disposeWorkspace(
	signal: AbortSignal,
	log: ReturnType<typeof createLog>,
	resources: WorkspaceResources,
	dispose: () => void,
) {
	log.debug("disposed");
	signal.removeEventListener("abort", dispose);
	resources.uploads.dispose();
	resources.library.dispose();
	resources.tags.dispose();
	resources.quota.dispose();
}
