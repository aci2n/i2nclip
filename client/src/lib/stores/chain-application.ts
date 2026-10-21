import { get, writable } from "svelte/store";
import { createChainPairing } from "./chain-pairing.ts";
import {
	type ChainWorkspace,
	createChainWorkspace,
} from "./chain-workspace.ts";
import {
	type ContentStreams,
	createContentStreams,
} from "./content-streams.ts";
import { createExtensionReceiver } from "./extension.ts";
import { createSession, type LibraryContext } from "./identity.ts";
import { createPreferences } from "./preferences.ts";
import { createRouting } from "./routing.ts";

interface Options {
	session?: ReturnType<typeof createSession>;
	preferences?: ReturnType<typeof createPreferences>;
	routing?: ReturnType<typeof createRouting>;
}
export type ChainApplication = ReturnType<typeof createChainApplication>;
export function createChainApplication(
	options: Options = {},
): Pick<ChainApplicationImpl, keyof ChainApplicationImpl> {
	return new ChainApplicationImpl(options);
}
class ChainApplicationImpl {
	readonly session: ReturnType<typeof createSession>;
	readonly preferences: ReturnType<typeof createPreferences>;
	readonly routing: ReturnType<typeof createRouting>;
	readonly pairing: ReturnType<typeof createChainPairing>;
	private readonly state = writable<{ workspace: ChainWorkspace | null }>({
		workspace: null,
	});
	private workspace: ChainWorkspace | null = null;
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
		this.pairing = createChainPairing(session, {
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
			this.workspace = createChainWorkspace(
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
		if (
			!workspace ||
			get(workspace.view).historical ||
			get(this.session).pendingRotation ||
			(get(workspace.view).selected && get(workspace.library).readonly)
		) {
			return null;
		}
		return workspace.uploads;
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
