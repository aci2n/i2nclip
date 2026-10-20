import { createLog } from "../log.ts";
import type { ContentStreams } from "./content-streams.ts";
import { createLibrary } from "./library.ts";
import type { Preferences } from "./preferences.ts";
import { createQuota } from "./quota.ts";
import type { LibraryContext } from "./session.ts";
import { createTags } from "./tags.ts";
import { createUploads } from "./uploads.ts";

export type Workspace = Pick<WorkspaceStore, keyof WorkspaceStore>;

// One owner replaces all library state when its fixed identity context ends.
export function createWorkspace(
	context: LibraryContext,
	preferences: Preferences,
	streams?: ContentStreams,
): Workspace {
	return new WorkspaceStore(context, preferences, streams);
}

class WorkspaceStore {
	private readonly log = createLog("workspace");
	private started = false;
	private disposed = false;
	readonly context: LibraryContext;
	readonly quota: ReturnType<typeof createQuota>;
	readonly tags: ReturnType<typeof createTags>;
	readonly library: ReturnType<typeof createLibrary>;
	readonly uploads: ReturnType<typeof createUploads>;

	readonly start = this.startWorkspace.bind(this);
	readonly dispose = this.disposeWorkspace.bind(this);

	constructor(
		context: LibraryContext,
		preferences: Preferences,
		streams?: ContentStreams,
	) {
		this.context = context;
		this.quota = createQuota(context);
		this.tags = createTags(context);
		this.library = createLibrary(context, {
			onChange: this.tags.refresh,
			mediaOptions: { streams },
		});
		this.uploads = createUploads(context, {
			preferences,
			onComplete: this.uploadsCompleted.bind(this),
		});
		this.log.debug("created");
		if (context.signal.aborted) {
			this.disposeWorkspace();
		} else {
			context.signal.addEventListener("abort", this.dispose, { once: true });
		}
	}

	private startWorkspace() {
		if (this.started || this.disposed) {
			return;
		}
		this.started = true;
		void this.quota.refresh();
		void this.tags.refresh();
		void this.library.search();
	}

	private uploadsCompleted() {
		void this.tags.refresh();
		return this.library.refresh();
	}

	private disposeWorkspace() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.log.debug("disposed");
		this.context.signal.removeEventListener("abort", this.dispose);
		this.uploads.dispose();
		this.library.dispose();
		this.tags.dispose();
		this.quota.dispose();
	}
}
