import { get, writable } from "svelte/store";
import { sendUpload } from "../media/upload.js";

const empty = () => ({
	uploading: false,
	progress: null,
	failures: [],
	completed: [],
	status: "",
});

// Application owns this store so batches survive navigation between views.
export function createUploads(
	session,
	{ send = sendUpload, onComplete, preferences },
) {
	const state = writable(empty());
	const controller = new AbortController();
	let disposed = false;
	let revision = 0;
	let epoch = session.epoch;
	const unsubscribe = session.subscribe((value) => {
		if (epoch !== value.epoch) {
			epoch = value.epoch;
			revision++;
			state.set(empty());
		}
	});
	async function upload(files, extra = {}) {
		if (
			disposed ||
			get(state).uploading ||
			!files.length ||
			!get(session).unlocked ||
			!get(session).configured ||
			get(session).busy
		) {
			return false;
		}
		const own = ++revision;
		const signal = AbortSignal.any([controller.signal, session.signal]);
		const credentials = session.credentials();
		const compressImages = preferences ? get(preferences).compressImages : true;
		state.update((v) => ({
			...v,
			uploading: true,
			status: "",
			failures: [],
			completed: [],
		}));
		const failed = [];
		for (const [index, file] of files.entries()) {
			if (disposed || signal.aborted || own !== revision) {
				break;
			}
			state.update((v) => ({
				...v,
				progress: {
					name: file.name,
					index: index + 1,
					total: files.length,
					percent: 0,
				},
			}));
			let finished = false;
			try {
				const item = await send({
					file,
					compressImages,
					extra,
					credentials,
					signal,
					onProgress: (percent) => {
						if (!finished && !disposed && !signal.aborted && own === revision) {
							state.update((v) => ({
								...v,
								progress: {
									name: file.name,
									index: index + 1,
									total: files.length,
									percent,
								},
							}));
						}
					},
				});
				if (!disposed && !signal.aborted && own === revision) {
					state.update((v) => ({
						...v,
						completed: [...v.completed, { id: item.id, name: file.name }],
					}));
				}
			} catch (error) {
				if (!disposed && !signal.aborted && own === revision) {
					failed.push({ name: file.name, error: error.message });
				}
			} finally {
				finished = true;
			}
		}
		if (disposed || signal.aborted || own !== revision) {
			return false;
		}
		state.update((v) => ({
			...v,
			uploading: false,
			progress: null,
			failures: failed,
			status: failed.length
				? `${failed.length} file(s) failed. Select the failed files again through Upload.`
				: "Upload complete.",
		}));
		await onComplete();
		return !disposed && !signal.aborted && own === revision && !failed.length;
	}

	return {
		subscribe: state.subscribe,
		upload,
		dismissCompleted: () =>
			state.update((v) => ({
				...v,
				completed: [],
				status: v.failures.length || v.uploading ? v.status : "",
			})),
		dispose() {
			disposed = true;
			revision++;
			controller.abort();
			unsubscribe();
			state.set(empty());
		},
	};
}
