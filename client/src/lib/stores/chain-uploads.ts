import { get, writable } from "svelte/store";
import type { ChainApi } from "../chain-api.ts";
import { errorMessage } from "../error.ts";
import type { Files } from "../files.ts";
import { prepareFile } from "../media/prepare.ts";
import { thumbnail } from "../media/thumbnail.ts";
import type { UploadState } from "../media/upload-state.ts";
import { contentShape } from "../protocol/content.ts";
import { manifestSize } from "../protocol/file-objects.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { stateCheckpoint } from "./chain.ts";
import type { Session } from "./identity.ts";
import type { MaterializedView } from "./materialized-view.ts";
import type { Preferences } from "./preferences.ts";

interface ActiveUpload {
	name: string;
	index: number;
	total: number;
	signal: AbortSignal;
	finished: boolean;
}
interface Services {
	readonly prepare?: typeof prepareFile;
	readonly thumbnail?: typeof thumbnail;
	readonly settled?: () => unknown;
}
const empty = (): UploadState => ({
	notices: [],
	uploading: false,
	progress: null,
	failures: [],
	completed: [],
	status: "",
});
export type ChainUploads = ReturnType<typeof createChainUploads>;
export function createChainUploads(
	session: Session,
	view: MaterializedView,
	files: Pick<Files, "upload">,
	api: Pick<ChainApi, "quota">,
	preferences: Preferences,
	signal: AbortSignal,
	services: Services = {},
): Pick<ChainUploadsImpl, keyof ChainUploadsImpl> {
	return new ChainUploadsImpl(
		session,
		view,
		files,
		api,
		preferences,
		signal,
		services,
	);
}
class ChainUploadsImpl {
	private readonly session: Session;
	private readonly view: MaterializedView;
	private readonly files: Pick<Files, "upload">;
	private readonly api: Pick<ChainApi, "quota">;
	private readonly preferences: Preferences;
	private readonly prepare: typeof prepareFile;
	private readonly thumbnail: typeof thumbnail;
	private readonly settled: () => unknown;
	private readonly state = writable<UploadState>(empty());
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private batch: AbortController | null = null;
	private queue: File[] = [];
	private readonly subscriptions: Array<() => void> = [];
	readonly subscribe = this.state.subscribe;
	readonly upload = this.uploadFiles.bind(this);
	readonly dismissCompleted = this.clearNotices.bind(this);
	readonly dispose = this.disposeUploads.bind(this);
	constructor(
		session: Session,
		view: MaterializedView,
		files: Pick<Files, "upload">,
		api: Pick<ChainApi, "quota">,
		preferences: Preferences,
		signal: AbortSignal,
		services: Services,
	) {
		this.session = session;
		this.view = view;
		this.files = files;
		this.api = api;
		this.preferences = preferences;
		this.prepare = services.prepare ?? prepareFile;
		this.thumbnail = services.thumbnail ?? thumbnail;
		this.settled = services.settled ?? (() => {});
		this.signal = AbortSignal.any([signal, this.controller.signal]);
		this.subscriptions.push(
			view.subscribe(this.guardBatch.bind(this)),
			session.subscribe(this.guardBatch.bind(this)),
		);
	}
	private allowed() {
		const source = get(this.view);
		return (
			Boolean(source.selected) &&
			!source.historical &&
			!get(this.session).pendingRotation &&
			!this.signal.aborted
		);
	}
	private guardBatch() {
		if (!this.allowed()) {
			this.batch?.abort(
				new Error(
					"Uploads stopped because the selected view or device authority changed.",
				),
			);
		}
	}
	private clearNotices() {
		this.state.update((state) => ({
			...state,
			completed: [],
			notices: [],
			status: state.failures.length || state.uploading ? state.status : "",
		}));
	}
	private async uploadFiles(files: File[], extra: Metadata = {}) {
		if (!files.length || get(this.state).uploading || !this.allowed()) {
			return false;
		}
		this.batch = new AbortController();
		const signal = AbortSignal.any([this.signal, this.batch.signal]);
		this.queue = [...files];
		const total = this.queue.length;
		const compressImages = get(this.preferences).compressImages;
		this.state.set({ ...empty(), uploading: true });
		let index = 0;
		try {
			while (this.queue.length) {
				signal.throwIfAborted();
				const file = this.queue.shift();
				if (!file) {
					break;
				}
				index++;
				const current: ActiveUpload = {
					name: file.name,
					index,
					total,
					signal,
					finished: false,
				};
				this.progress(current, "preparing", 0);
				let thumb: Awaited<ReturnType<typeof thumbnail>> = null;
				try {
					manifestSize(file.size);
					const shape = contentShape(file.size);
					const quota = await this.api.quota(signal);
					signal.throwIfAborted();
					if (
						quota.retainedFiles >= quota.maximumFiles ||
						shape.encryptedBytes > quota.maximumBytes - quota.usedBytes
					) {
						throw new Error("This file exceeds the available storage quota.");
					}
					const selected = get(this.view).selected;
					if (!selected || !this.allowed()) {
						throw new Error("Upload requires the live view.");
					}
					const expected = stateCheckpoint(selected);
					const prepared = await this.prepare({
						file,
						compressImages,
						signal,
						onNotice: this.notice.bind(this, current),
					});
					signal.throwIfAborted();
					current.name = prepared.name;
					this.progress(current, "preparing", 0);
					thumb = await this.thumbnail(prepared, signal);
					signal.throwIfAborted();
					const { id } = await this.files.upload({
						file: prepared,
						attributes: {
							...extra,
							name: current.name,
							content_type: prepared.type,
							...(thumb ? { image: thumb.image } : {}),
						},
						thumbnail: thumb?.thumb,
						expected,
						signal,
						onProgress: this.progress.bind(this, current, "uploading"),
					});
					signal.throwIfAborted();
					this.state.update((state) => ({
						...state,
						completed: [...state.completed, { id, name: current.name }],
					}));
				} catch (error) {
					if (!signal.aborted) {
						this.state.update((state) => ({
							...state,
							failures: [
								...state.failures,
								{ name: current.name, error: errorMessage(error) },
							],
						}));
					}
				} finally {
					current.finished = true;
					thumb?.thumb.fill(0);
				}
			}
			signal.throwIfAborted();
			const failed = get(this.state).failures.length;
			this.state.update((state) => ({
				...state,
				status: failed
					? `${failed} file(s) failed. Select them again through Upload.`
					: "Upload complete.",
			}));
			return !failed;
		} catch (error) {
			if (!this.signal.aborted) {
				this.state.update((state) => ({
					...state,
					status: errorMessage(error),
				}));
			}
			return false;
		} finally {
			this.queue.length = 0;
			this.batch = null;
			if (!this.signal.aborted) {
				this.state.update((state) => ({
					...state,
					uploading: false,
					progress: null,
				}));
				await this.settled();
			}
		}
	}
	private progress(
		current: ActiveUpload,
		phase: "preparing" | "uploading",
		percent: number,
	) {
		if (
			current.signal.aborted ||
			current.finished ||
			!Number.isFinite(percent)
		) {
			return;
		}
		this.state.update((state) => ({
			...state,
			progress: {
				name: current.name,
				index: current.index,
				total: current.total,
				percent: Math.max(0, Math.min(100, Math.round(percent))),
				phase,
			},
		}));
	}
	private notice(current: ActiveUpload, message: string) {
		if (!current.signal.aborted && !current.finished) {
			this.state.update((state) => ({
				...state,
				notices: [...state.notices, { name: current.name, message }],
			}));
		}
	}

	private disposeUploads() {
		this.controller.abort();
		this.batch?.abort();
		this.queue.length = 0;
		for (const unsubscribe of this.subscriptions) {
			unsubscribe();
		}
		this.state.set(empty());
	}
}
