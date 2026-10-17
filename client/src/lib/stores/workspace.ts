import { createLibrary } from "./library.ts";
import type { Preferences } from "./preferences.ts";
import type { LibraryContext } from "./session.ts";
import { createTags } from "./tags.ts";
import { createUploads } from "./uploads.ts";

// One owner replaces all library state when its fixed identity context ends.
export function createWorkspace(
	context: LibraryContext,
	preferences: Preferences,
) {
	const tags = createTags(context);
	const library = createLibrary(context, { onChange: tags.refresh });
	const uploads = createUploads(context, {
		preferences,
		onComplete: () => {
			void tags.refresh();
			return library.refresh();
		},
	});
	function dispose() {
		context.signal.removeEventListener("abort", dispose);
		uploads.dispose();
		library.dispose();
		tags.dispose();
	}
	context.signal.addEventListener("abort", dispose, { once: true });
	return { context, tags, library, uploads, dispose };
}
export type Workspace = ReturnType<typeof createWorkspace>;
