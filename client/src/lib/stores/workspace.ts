import { bytesToHex } from "../protocol/bytes.ts";
import { createFiles } from "../services/files.ts";
import { createChainApi } from "../services/library-api.ts";
import { createChainStorage } from "../storage/chain.ts";
import { createChain } from "./chain.ts";
import type { ContentStreams } from "./content-streams.ts";
import { createLibrary } from "./library.ts";
import { createMaterializedView } from "./materialized-view.ts";
import type { Preferences } from "./preferences.ts";
import { createQuota } from "./quota.ts";
import type { LibraryContext, Session } from "./session.ts";
import { createUploads } from "./uploads.ts";

export type Workspace = ReturnType<typeof createWorkspace>;
export function createWorkspace(
	context: LibraryContext,
	session: Session,
	preferences: Preferences,
	streams: ContentStreams,
): Pick<WorkspaceImpl, keyof WorkspaceImpl> {
	return new WorkspaceImpl(context, session, preferences, streams);
}
class WorkspaceImpl {
	readonly context: LibraryContext;
	readonly api: ReturnType<typeof createChainApi>;
	private readonly cache: ReturnType<typeof createChainStorage>;
	readonly chain: ReturnType<typeof createChain>;
	private readonly files: ReturnType<typeof createFiles>;
	readonly view: ReturnType<typeof createMaterializedView>;
	readonly quota: ReturnType<typeof createQuota>;
	readonly library: ReturnType<typeof createLibrary>;
	readonly uploads: ReturnType<typeof createUploads>;
	private started = false;
	private disposed = false;
	readonly start = this.startWorkspace.bind(this);
	readonly dispose = this.disposeWorkspace.bind(this);
	constructor(
		context: LibraryContext,
		session: Session,
		preferences: Preferences,
		streams: ContentStreams,
	) {
		this.context = context;
		this.api = createChainApi(context.serverUrl, context.key, context.signal);
		this.cache = createChainStorage(
			context.serverUrl,
			bytesToHex(context.library),
		);
		this.chain = createChain(
			{
				genesis: context.genesis,
				signing: context.key,
				encryption: context.encryption,
				minimum: context.head,
			},
			this.cache,
			this.api,
			context.signal,
		);
		this.files = createFiles(
			context.library,
			this.chain,
			this.api,
			context.signal,
		);
		this.view = createMaterializedView(this.chain, this.files, context.signal);
		this.quota = createQuota(this.api, context.signal);
		this.library = createLibrary(
			session,
			this.chain,
			this.view,
			this.files,
			streams,
			context.signal,
			{ changed: this.quota.refresh },
		);
		this.uploads = createUploads(
			session,
			this.view,
			this.files,
			this.api,
			preferences,
			context.signal,
			{ settled: this.quota.refresh },
		);
		if (context.signal.aborted) {
			this.dispose();
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
		void this.chain.sync().catch(() => {});
	}
	private disposeWorkspace() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.context.signal.removeEventListener("abort", this.dispose);
		this.uploads.dispose();
		this.library.dispose();
		this.view.dispose();
		this.chain.dispose();
		this.files.dispose();
		this.cache.dispose();
		this.api.dispose();
		this.quota.dispose();
	}
}
