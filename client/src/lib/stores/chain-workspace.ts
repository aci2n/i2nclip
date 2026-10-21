import { createChainApi } from "../chain-api.ts";
import { createChainStorage } from "../chain-storage.ts";
import { createFiles } from "../files.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import { createChain } from "./chain.ts";
import { createChainLibrary } from "./chain-library.ts";
import { createChainQuota } from "./chain-quota.ts";
import { createChainUploads } from "./chain-uploads.ts";
import type { ContentStreams } from "./content-streams.ts";
import { createDevices } from "./devices.ts";
import type { LibraryContext, Session } from "./identity.ts";
import { createMaterializedView } from "./materialized-view.ts";
import type { Preferences } from "./preferences.ts";

export type ChainWorkspace = ReturnType<typeof createChainWorkspace>;
export function createChainWorkspace(
	context: LibraryContext,
	session: Session,
	preferences: Preferences,
	streams: ContentStreams,
): Pick<ChainWorkspaceImpl, keyof ChainWorkspaceImpl> {
	return new ChainWorkspaceImpl(context, session, preferences, streams);
}
class ChainWorkspaceImpl {
	readonly context: LibraryContext;
	readonly api: ReturnType<typeof createChainApi>;
	private readonly cache: ReturnType<typeof createChainStorage>;
	readonly chain: ReturnType<typeof createChain>;
	private readonly files: ReturnType<typeof createFiles>;
	readonly view: ReturnType<typeof createMaterializedView>;
	readonly quota: ReturnType<typeof createChainQuota>;
	readonly library: ReturnType<typeof createChainLibrary>;
	readonly uploads: ReturnType<typeof createChainUploads>;
	readonly devices: ReturnType<typeof createDevices>;
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
			bytesToHex(context.identity.library),
		);
		this.chain = createChain(
			{
				genesis: context.identity.genesis,
				publicKey: context.key.publicKey,
				signingKey: context.key.privateCryptoKey,
				secrets: new Map(context.identity.epochs),
				encryption: {
					publicKey: context.identity.encryption.publicKey,
					keyPair: context.encryptionKey,
				},
				minimum: context.identity.head,
			},
			this.cache,
			this.api,
			context.signal,
		);
		this.files = createFiles(
			context.identity.library,
			this.chain,
			this.api,
			context.signal,
		);
		this.view = createMaterializedView(this.chain, this.files, context.signal);
		this.quota = createChainQuota(this.api, context.signal);
		this.library = createChainLibrary(
			session,
			this.chain,
			this.view,
			this.files,
			streams,
			context.signal,
			{ changed: this.quota.refresh },
		);
		this.uploads = createChainUploads(
			session,
			this.view,
			this.files,
			this.api,
			preferences,
			context.signal,
			{ settled: this.quota.refresh },
		);
		this.devices = createDevices(session, this.chain, this.api, context.signal);
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
		this.devices.dispose();
		this.library.dispose();
		this.view.dispose();
		this.chain.dispose();
		this.files.dispose();
		this.cache.dispose();
		this.api.dispose();
		this.quota.dispose();
	}
}
