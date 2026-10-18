import { get } from "svelte/store";
import { DEFAULT_MAX_FILE_PLAINTEXT_BYTES } from "../api.ts";
import { createLog } from "../log.ts";
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
) {
	const log = createLog("workspace");
	log.debug("created");
	const quota = createQuota(context);
	void quota.refresh();
	const tags = createTags(context);
	const library = createLibrary(context, { onChange: tags.refresh });
	const uploads = createUploads(context, {
		preferences,
		getMaxFilePlaintextBytes: () =>
			get(quota).value?.max_file_plaintext_bytes ??
			DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
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
