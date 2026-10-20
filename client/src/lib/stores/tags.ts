import { type Writable, writable } from "svelte/store";
import type { TagApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import type { LibraryContext } from "./session.ts";

const empty = (): {
	tags: string[];
	loading: boolean;
	error: string;
	warning: string;
} => ({ tags: [], loading: false, error: "", warning: "" });

// Application owns the catalog for the unlocked identity, independently of pages.
export type Tags = ReturnType<typeof createTags>;
export function createTags(
	context: LibraryContext,
	options: { http?: TagApi } = {},
): Pick<TagsStoreImpl, keyof TagsStoreImpl> {
	return new TagsStoreImpl(context, options);
}

class TagsStoreImpl {
	private readonly context: LibraryContext;
	private readonly http: TagApi;
	private readonly log: ReturnType<typeof createLog>;
	private readonly state: Writable<ReturnType<typeof empty>>;
	private controller?: AbortController;
	private disposed: boolean;

	readonly subscribe: Writable<ReturnType<typeof empty>>["subscribe"];
	readonly refresh = this.refreshTags.bind(this);
	readonly dispose = this.disposeTags.bind(this);

	constructor(context: LibraryContext, { http = api }: { http?: TagApi } = {}) {
		this.context = context;
		this.http = http;
		this.log = createLog("tags");
		this.state = writable(empty());
		this.subscribe = this.state.subscribe;
		this.disposed = false;
	}

	private async refreshTags() {
		if (this.disposed || this.context.signal.aborted) {
			return false;
		}
		this.controller?.abort();
		this.controller = new AbortController();
		const operation = this.log.operation();
		this.log.debug("refresh-started", { operation });
		const signal = AbortSignal.any([
			this.controller.signal,
			this.context.signal,
		]);
		this.state.update((v) => ({ ...v, loading: true, error: "" }));
		try {
			const result = await this.http.getTags({ ...this.context, signal });
			if (signal.aborted) {
				this.log.debug("refresh-stale", { operation });
				return false;
			}
			this.log.debug("refresh-completed", { operation });
			if (result.invalid) {
				this.log.warn("partial-catalog", {
					operation,
					invalid: result.invalid,
				});
			}
			this.state.set({
				tags: result.tags,
				loading: false,
				error: "",
				warning: result.invalid ? "Some tag suggestions are unavailable." : "",
			});
			return true;
		} catch (error) {
			if (signal.aborted) {
				this.log.debug("refresh-cancelled", { operation });
			} else {
				this.log.warn("refresh-failed", { operation, ...failureFields(error) });
			}
			if (!signal.aborted) {
				this.state.update((v) => ({
					...v,
					loading: false,
					error: errorMessage(error),
				}));
			}
			return false;
		}
	}

	private disposeTags() {
		this.log.debug("disposed");
		this.disposed = true;
		this.controller?.abort();
		this.state.set(empty());
	}
}
