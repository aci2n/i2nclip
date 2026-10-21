import { get, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import type { ChainApi, StorageQuota } from "../services/library-api.ts";
export type Quota = ReturnType<typeof createQuota>;
export function createQuota(
	api: Pick<ChainApi, "quota">,
	signal: AbortSignal,
): Pick<QuotaImpl, keyof QuotaImpl> {
	return new QuotaImpl(api, signal);
}
class QuotaImpl {
	private readonly api: Pick<ChainApi, "quota">;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private readonly state = writable<{
		value: StorageQuota | null;
		loading: boolean;
		error: string;
	}>({ value: null, loading: false, error: "" });
	readonly subscribe = this.state.subscribe;
	readonly refresh = this.readQuota.bind(this);
	readonly dispose = this.disposeQuota.bind(this);
	constructor(api: Pick<ChainApi, "quota">, signal: AbortSignal) {
		this.api = api;
		this.signal = AbortSignal.any([signal, this.controller.signal]);
	}
	private async readQuota() {
		if (this.signal.aborted || get(this.state).loading) {
			return false;
		}
		this.state.update((state) => ({ ...state, loading: true, error: "" }));
		try {
			const value = await this.api.quota(this.signal);
			this.signal.throwIfAborted();
			this.state.set({ value, loading: false, error: "" });
			return true;
		} catch (error) {
			if (!this.signal.aborted) {
				this.state.update((state) => ({
					...state,
					loading: false,
					error: errorMessage(error),
				}));
			}
			return false;
		}
	}
	private disposeQuota() {
		this.controller.abort();
		this.state.set({ value: null, loading: false, error: "" });
	}
}
