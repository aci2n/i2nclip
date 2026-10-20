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
import { createSession, type LibraryContext } from "./session.ts";
import { createWorkspace, type Workspace } from "./workspace.ts";

interface ApplicationOptions {
	session?: ReturnType<typeof createSession>;
	preferences?: ReturnType<typeof createPreferences>;
}
export type Application = Pick<ApplicationStore, keyof ApplicationStore>;

export function createApplication(
	options: ApplicationOptions = {},
): Application {
	return new ApplicationStore(options);
}

class ApplicationStore {
	private readonly log = createLog("application");
	private readonly state = writable<{
		workspace: Workspace | null;
		streams: ContentStreams | null;
	}>({ workspace: null, streams: null });
	private workspace: Workspace | null = null;
	private streams: ContentStreams | null = null;
	private streamContext: LibraryContext | null = null;
	private started = false;
	private disposed = false;
	private readonly subscriptions: Array<() => void> = [];
	private extension?: ReturnType<typeof createExtensionReceiver>;
	readonly session: ReturnType<typeof createSession>;
	readonly preferences: ReturnType<typeof createPreferences>;
	readonly routing: ReturnType<typeof createRouting>;
	readonly pairing: ReturnType<typeof createPairing>;

	readonly subscribe = this.state.subscribe;
	readonly start = this.startApplication.bind(this);
	readonly canDropFiles = this.acceptsFiles.bind(this);
	readonly dropFiles = this.uploadDroppedFiles.bind(this);
	readonly dispose = this.disposeApplication.bind(this);

	constructor({
		session = createSession(),
		preferences = createPreferences(),
	}: ApplicationOptions) {
		this.session = session;
		this.preferences = preferences;
		this.routing = createRouting();
		this.pairing = createPairing(session);
		this.log.debug("created");
	}

	private startApplication() {
		if (this.started || this.disposed) {
			return;
		}
		this.started = true;
		try {
			for (const store of [this.session, this.routing, this.preferences]) {
				const unsubscribe = store.subscribe(() => this.syncWorkspace());
				if (this.disposed) {
					unsubscribe();
					return;
				}
				this.subscriptions.push(unsubscribe);
			}
			this.extension = createExtensionReceiver(
				this.session,
				() => this.workspace?.uploads ?? null,
				this.openCaptureLibrary.bind(this),
			);
			void this.session.load();
			void this.preferences.load();
		} catch (error) {
			this.disposeApplication();
			throw error;
		}
	}

	private syncWorkspace() {
		if (this.disposed) {
			return;
		}
		const context = get(this.session).context;
		if (this.streamContext !== context) {
			this.streams?.dispose();
			this.streamContext = context;
			this.streams = context ? createContentStreams(context.signal) : null;
		}
		if (this.workspace && this.workspace.context !== context) {
			this.log.debug("workspace-ended", { reason: "context-changed" });
			this.workspace.dispose();
			this.workspace = null;
		}
		if (
			context &&
			!get(this.preferences).loading &&
			get(this.routing).workspace &&
			!this.workspace
		) {
			this.log.debug("workspace-created");
			this.workspace = createWorkspace(
				context,
				this.preferences,
				this.streams ?? undefined,
			);
			this.workspace.start();
		}
		this.state.set({ workspace: this.workspace, streams: this.streams });
	}

	private acceptsFiles() {
		return (
			!this.disposed &&
			this.session.ready &&
			this.workspace !== null &&
			!get(this.workspace.uploads).uploading
		);
	}

	private uploadDroppedFiles(files: File[]) {
		if (!files.length || !this.acceptsFiles() || !this.workspace) {
			this.log.debug("drop-rejected", { count: files.length });
			return;
		}
		this.routing.navigate({ page: "library" }, true);
		this.log.info("drop-accepted", { count: files.length });
		void this.workspace.uploads.upload(files);
	}

	private openCaptureLibrary() {
		this.routing.navigate({ page: "library" }, true);
		// Captures may resume before queued routing subscribers run.
		this.syncWorkspace();
	}

	private disposeApplication() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.log.debug("disposed");
		this.extension?.dispose();
		this.pairing.dispose();
		for (const unsubscribe of this.subscriptions.splice(0)) {
			unsubscribe();
		}
		this.preferences.dispose();
		this.routing.dispose();
		this.workspace?.dispose();
		this.workspace = null;
		this.streams?.dispose();
		this.streams = null;
		this.state.set({ workspace: null, streams: null });
		this.session.dispose();
	}
}
