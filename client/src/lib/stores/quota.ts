import { get, type Writable, writable } from "svelte/store";
import type { Quota, QuotaApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import type { LibraryContext } from "./session.ts";

const empty = (): {
	value: Quota | null;
	loading: boolean;
	error: string;
} => ({ value: null, loading: false, error: "" });

export type QuotaStore = ReturnType<typeof createQuota>;
export function createQuota(
	context: LibraryContext,
	options: { http?: QuotaApi } = {},
): Pick<QuotaStoreImpl, keyof QuotaStoreImpl> {
	return new QuotaStoreImpl(context, options);
}

class QuotaStoreImpl {
	private readonly context: LibraryContext;
	private readonly http: QuotaApi;
	private readonly log: ReturnType<typeof createLog>;
	private readonly state: Writable<ReturnType<typeof empty>>;
	private controller?: AbortController;
	private disposed: boolean;

	readonly subscribe: Writable<ReturnType<typeof empty>>["subscribe"];
	readonly refresh = this.refreshQuota.bind(this);
	readonly dispose = this.disposeQuota.bind(this);

	constructor(
		context: LibraryContext,
		{ http = api }: { http?: QuotaApi } = {},
	) {
		this.context = context;
		this.http = http;
		this.log = createLog("quota");
		this.state = writable(empty());
		this.subscribe = this.state.subscribe;
		this.disposed = false;
	}

	private async refreshQuota() {
		if (
			this.disposed ||
			get(this.state).loading ||
			this.context.signal.aborted
		) {
			return false;
		}
		this.controller = new AbortController();
		const operation = this.log.operation();
		this.log.debug("refresh-started", { operation });
		const signal = AbortSignal.any([
			this.controller.signal,
			this.context.signal,
		]);
		this.state.set({ value: null, loading: true, error: "" });
		try {
			const quota = await this.http.getQuota({ ...this.context, signal });
			if (signal.aborted) {
				this.log.debug("refresh-stale", { operation });
				return false;
			}
			this.log.debug("refresh-completed", { operation });
			this.state.set({ value: quota, loading: false, error: "" });
			return true;
		} catch (error) {
			if (signal.aborted) {
				this.log.debug("refresh-cancelled", { operation });
			} else {
				this.log.warn("refresh-failed", { operation, ...failureFields(error) });
			}
			if (!signal.aborted) {
				this.state.set({
					value: null,
					loading: false,
					error: errorMessage(error),
				});
			}
			return false;
		}
	}

	private disposeQuota() {
		this.log.debug("disposed");
		this.disposed = true;
		this.controller?.abort();
		this.state.set(empty());
	}
}
