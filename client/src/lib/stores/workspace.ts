import { createLog } from "../log.ts";
import type { ContentStreams } from "./content-streams.ts";
import { createLibrary } from "./library.ts";
import type { Preferences } from "./preferences.ts";
import { createQuota } from "./quota.ts";
import type { LibraryContext } from "./session.ts";
import { createTags } from "./tags.ts";
import { createUploads } from "./uploads.ts";

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
		onComplete: () => {
			void tags.refresh();
			return library.refresh();
		},
	});
	function dispose() {
		log.debug("disposed");
		context.signal.removeEventListener("abort", dispose);
		uploads.dispose();
		library.dispose();
		tags.dispose();
		quota.dispose();
	}
	context.signal.addEventListener("abort", dispose, { once: true });
	return { context, tags, library, uploads, quota, dispose };
}
export type Workspace = ReturnType<typeof createWorkspace>;
