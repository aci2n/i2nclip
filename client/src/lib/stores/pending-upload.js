import { get, writable } from "svelte/store";

export function createPendingUpload(
	client,
	platform,
	id,
	{ auto = false } = {},
) {
	const tags = writable("");
	const state = writable({
		ready: false,
		busy: false,
		name: "",
		preview: "",
		status: "Loading…",
		available: false,
	});
	let disposed = false;
	let preview = "";
	let requesting = false;
	let attempted = false;
	let sent = false;
	let epoch;
	const update = (patch) => state.update((value) => ({ ...value, ...patch }));
	async function source() {
		if (requesting || preview || disposed) {
			return;
		}
		requesting = true;
		const captured = get(client);
		const current = () =>
			!disposed &&
			get(client).connected &&
			get(client).session.unlocked &&
			get(client).instanceId === captured.instanceId &&
			get(client).session.epoch === captured.session.epoch;
		try {
			const result = await client.command("pending.get", { id });
			if (!current()) {
				return;
			}
			if (!result) {
				attempted = false;
			}
			if (!disposed && result?.blob?.type.startsWith("image/")) {
				preview = URL.createObjectURL(result.blob);
				update({ preview });
			}
		} catch {
			/* Job status carries the authoritative preparation error. */
		} finally {
			requesting = false;
			if (!current()) {
				attempted = false;
				const latest = get(client);
				if (
					!disposed &&
					latest.connected &&
					latest.session.unlocked &&
					latest.uploads.some((job) => job.id === id)
				) {
					void source();
				}
			}
		}
	}
	const unsubscribe = client.subscribe((value) => {
		if (disposed) {
			return;
		}
		if (epoch !== value.session.epoch || !value.connected) {
			if (preview) {
				URL.revokeObjectURL(preview);
			}
			preview = "";
			update({ preview });
		}
		epoch = value.session.epoch;
		if (!value.connected || !value.session.unlocked) {
			tags.set("");
			if (preview) {
				URL.revokeObjectURL(preview);
			}
			preview = "";
			attempted = false;
			update({
				ready: value.session.ready,
				busy: false,
				available: false,
				name: "",
				preview: "",
				status: "",
			});
			return;
		}
		const job = value.uploads.find((job) => job.id === id);
		if (!value.session.ready) {
			return;
		}
		const busy = ["queued", "preparing", "uploading"].includes(job?.status);
		update({
			ready: true,
			busy,
			available: Boolean(job && job.status !== "completed"),
			name: job?.name || "",
			status: !job
				? "Nothing to upload."
				: job.status === "completed"
					? "Uploaded."
					: busy
						? `Uploading…${job.progress == null ? "" : ` ${job.progress}%`}`
						: job.error || "",
		});
		if (job && job.status !== "completed" && !attempted && !requesting) {
			attempted = true;
			void source();
		}
		if (job?.status === "completed" && (sent || auto)) {
			platform.close();
		}
	});
	const ready = client.ready;
	return {
		subscribe: state.subscribe,
		ready,
		tags,
		async send(tags) {
			if (disposed || get(state).busy || !get(state).available) {
				return;
			}
			sent = true;
			try {
				await client.command("pending.send", { id, tags });
			} catch (error) {
				if (!disposed) {
					update({ status: error.message });
				}
			}
		},
		dispose() {
			disposed = true;
			unsubscribe();
			if (preview) {
				URL.revokeObjectURL(preview);
			}
		},
	};
}
