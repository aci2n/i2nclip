import { get, writable } from "svelte/store";
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

interface Options {
	session?: ReturnType<typeof createSession>;
	preferences?: ReturnType<typeof createPreferences>;
	routing?: ReturnType<typeof createRouting>;
}
export type Application = ReturnType<typeof createApplication>;
export function createApplication(
	options: Options = {},
): Pick<ApplicationImpl, keyof ApplicationImpl> {
	return new ApplicationImpl(options);
}
class ApplicationImpl {
	readonly session: ReturnType<typeof createSession>;
	readonly preferences: ReturnType<typeof createPreferences>;
	readonly routing: ReturnType<typeof createRouting>;
	readonly pairing: ReturnType<typeof createPairing>;
	private readonly state = writable<{ workspace: Workspace | null }>({
		workspace: null,
	});
	private workspace: Workspace | null = null;
	private streams: ContentStreams | null = null;
	private context: LibraryContext | null = null;
	private extension: ReturnType<typeof createExtensionReceiver> | null = null;
	private readonly subscriptions: Array<() => void> = [];
	private started = false;
	private disposed = false;
	readonly subscribe = this.state.subscribe;
	readonly start = this.startApplication.bind(this);
	readonly dispose = this.disposeApplication.bind(this);
	readonly canDropFiles = this.acceptsFiles.bind(this);
	readonly dropFiles = this.uploadDroppedFiles.bind(this);
	constructor({
		session = createSession(),
		preferences = createPreferences(),
		routing = createRouting(),
	}: Options) {
		this.session = session;
		this.preferences = preferences;
		this.routing = routing;
		this.pairing = createPairing(session, {
			chain: () => this.workspace?.chain ?? null,
		});
	}
	private startApplication() {
		if (this.started || this.disposed) {
			return;
		}
		this.started = true;
		try {
			for (const store of [this.session, this.preferences]) {
				const unsubscribe = store.subscribe(this.syncWorkspace.bind(this));
				if (this.disposed) {
					unsubscribe();
					return;
				}
				this.subscriptions.push(unsubscribe);
			}
			this.extension = createExtensionReceiver(
				this.session,
				this.captureUploads.bind(this),
				this.openCaptureLibrary.bind(this),
			);
			void this.session.load();
			void this.preferences.load();
		} catch (error) {
			this.disposeApplication();
			throw error;
		}
	}
	private openCaptureLibrary() {
		this.routing.navigate({ page: "library" }, true);
	}

	private syncWorkspace() {
		if (this.disposed) {
			return;
		}
		const context = get(this.session).context;
		if (context !== this.context) {
			this.workspace?.dispose();
			this.workspace = null;
			this.streams?.dispose();
			this.streams = context ? createContentStreams(context.signal) : null;
			this.context = context;
		}
		if (
			context &&
			!get(this.preferences).loading &&
			!this.workspace &&
			this.streams
		) {
			this.workspace = createWorkspace(
				context,
				this.session,
				this.preferences,
				this.streams,
			);
			this.workspace.start();
		}
		this.state.set({ workspace: this.workspace });
	}
	private acceptsFiles() {
		const workspace = this.workspace;
		if (this.disposed || !this.session.ready || !workspace) {
			return false;
		}
		return (
			!get(workspace.library).readonly && !get(workspace.uploads).uploading
		);
	}

	private captureUploads() {
		const workspace = this.workspace;
		return workspace && !get(workspace.view).historical
			? workspace.uploads
			: null;
	}

	private uploadDroppedFiles(files: File[]) {
		if (!files.length || !this.acceptsFiles() || !this.workspace) {
			return;
		}
		this.routing.navigate({ page: "library" }, true);
		void this.workspace.uploads.upload(files);
	}
	private disposeApplication() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.extension?.dispose();
		this.pairing.dispose();
		for (const unsubscribe of this.subscriptions) {
			unsubscribe();
		}
		this.workspace?.dispose();
		this.workspace = null;
		this.streams?.dispose();
		this.streams = null;
		this.context = null;
		this.preferences.dispose();
		this.routing.dispose();
		this.session.dispose();
		this.state.set({ workspace: null });
	}
}
