import { get, writable } from "svelte/store";
import { createMediaItem } from "./media-item.js";

export function createLibrary(client, platform) {
	const viewId = crypto.randomUUID();
	const cards = new Map();
	const state = writable({
		items: [],
		cards: [],
		selected: null,
		next: null,
		query: "",
		loading: false,
		empty: null,
		status: "",
		uploading: false,
		uploadProgress: null,
		uploadFailures: [],
		uploadCompleted: [],
		uploadStatus: "",
	});
	let disposed = false;
	let viewInstance;
	let opening = false;
	let previewRevision = 0;
	let uploadStatus = "";
	function clear() {
		previewRevision++;
		for (const media of cards.values()) media.dispose();
		cards.clear();
	}
	function open(value) {
		if (opening || !value.connected || viewInstance === value.clientId) return;
		opening = true;
		client
			.command("view.open", { id: viewId, query: get(state).query })
			.then(() => {
				viewInstance = value.clientId;
			})
			.catch((error) => {
				if (!disposed)
					state.update((current) => ({ ...current, status: error.message }));
			})
			.finally(() => {
				opening = false;
			});
	}
	const unsubscribe = client.subscribe((value) => {
		if (disposed) return;
		open(value);
		const view = value.views[viewId];
		const ids =
			value.connected && value.session.unlocked ? view?.ids || [] : [];
		for (const [id, media] of cards)
			if (!ids.includes(id)) {
				media.dispose();
				cards.delete(id);
			}
		const items = ids.map((id) => value.media[id]).filter(Boolean);
		for (const item of items)
			if (!cards.has(item.id))
				cards.set(item.id, createMediaItem(item, client, platform));
		const active = value.uploads.find((job) =>
			["preparing", "uploading"].includes(job.status),
		);
		const batch = active
			? value.uploads.filter((job) => job.batchId === active.batchId)
			: [];
		const failures = value.uploads
			.filter((job) => ["failed", "interrupted", "paused"].includes(job.status))
			.map((job) => ({
				...job,
				file: { name: job.name || "upload" },
				error:
					job.status === "interrupted"
						? "Interrupted. It may already be saved on the server; check before retrying."
						: job.status === "paused"
							? "Queued before restart. Retry to continue."
							: job.error,
			}));
		state.update((current) => ({
			...current,
			...(view || {}),
			query: view?.query ?? current.query,
			items,
			cards: items.map((item) => ({ item, media: cards.get(item.id) })),
			selected:
				current.selected &&
				ids.includes(current.selected.id) &&
				value.session.unlocked
					? current.selected
					: null,
			uploading: value.uploads.some((job) =>
				["queued", "preparing", "uploading"].includes(job.status),
			),
			uploadProgress: active
				? {
						name: active.name,
						index: batch.indexOf(active) + 1,
						total: batch.length,
						percent: active.progress || 0,
					}
				: null,
			uploadFailures: failures,
			uploadCompleted: value.uploads
				.filter((job) => job.status === "completed")
				.map((job) => job.id),
			uploadStatus,
		}));
	});
	async function action(name, payload) {
		try {
			return await client.command(name, payload);
		} catch (error) {
			if (!disposed)
				state.update((value) => ({ ...value, status: error.message }));
			return false;
		}
	}
	return {
		subscribe: state.subscribe,
		query: () => get(state).query,
		search: (query = get(state).query) =>
			action("view.search", { id: viewId, query }),
		more: () => action("view.more", { id: viewId }),
		media: (item) => cards.get(item.id),
		async upload(files) {
			const result = await action("uploads.submit", {
				sources: files.map((file) => ({ blob: file, name: file.name })),
			});
			if (result?.failures?.length) {
				uploadStatus = result.failures
					.map((failure) => `${failure.name}: ${failure.error}`)
					.join(" | ");
				state.update((value) => ({ ...value, uploadStatus }));
			}
		},
		retryUploads: () =>
			action("uploads.retry", {
				ids: get(state).uploadFailures.map((job) => job.id),
			}),
		discardUploads: () =>
			action("uploads.discard", {
				ids: get(state).uploadFailures.map((job) => job.id),
			}),
		dismissCompleted: () =>
			action("uploads.discard", { ids: get(state).uploadCompleted }),
		async reveal(id, opener) {
			const media = cards.get(id);
			const version = ++previewRevision;
			const url = await media?.reveal();
			if (
				!url ||
				disposed ||
				version !== previewRevision ||
				cards.get(id) !== media
			)
				return;
			const metadata = get(media).metadata;
			if (metadata?.content_type?.startsWith("image/"))
				state.update((value) => ({
					...value,
					selected: { id, url, name: metadata.name || id, opener },
				}));
		},
		closePreview() {
			previewRevision++;
			state.update((value) => ({ ...value, selected: null }));
		},
		async remove(id) {
			const media = cards.get(id);
			if (
				!media ||
				get(media).busy ||
				!platform.confirm(
					`Delete ${get(media).metadata?.name || id}? This cannot be undone.`,
				)
			)
				return;
			return media.remove();
		},
		retag: (id, tags) => cards.get(id)?.retag(tags),
		dispose() {
			disposed = true;
			unsubscribe();
			clear();
			void client.command("view.close", { id: viewId }).catch(() => {});
		},
	};
}
