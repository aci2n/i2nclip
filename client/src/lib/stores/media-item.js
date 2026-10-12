import { get, writable } from "svelte/store";
import { downloadName } from "../media/format.js";
import { sniffContentType } from "../media/metadata.js";

// UI resource owner. Fetching/decryption/mutations are service commands.
export function createMediaItem(initialItem, client, platform) {
	const urls = new Set();
	const controller = new AbortController();
	let disposed = false;
	let loading = false;
	let content;
	let thumb;
	const makeUrl = (blob) => {
		const url = URL.createObjectURL(blob);
		urls.add(url);
		return url;
	};
	const state = writable({
		...initialItem,
		busy: false,
		shown: false,
		url: "",
		preview: "",
		message: "",
		progress: null,
		error: false,
	});
	const revoke = () => {
		for (const url of urls) URL.revokeObjectURL(url);
		urls.clear();
		content = null;
	};
	const epoch = get(client).session.epoch;
	const instance = get(client).instanceId;
	const unsubscribe = client.subscribe((value) => {
		if (disposed) return;
		if (
			!value.connected ||
			value.instanceId !== instance ||
			value.session.epoch !== epoch
		) {
			revoke();
			controller.abort();
			state.update((current) => ({
				...current,
				url: "",
				preview: "",
				shown: false,
			}));
			return;
		}
		const item = value.media[initialItem.id];
		if (!item) return;
		if (item.deleted) {
			revoke();
			controller.abort();
		}
		let preview = get(state).preview;
		const sameThumb =
			thumb &&
			item.thumb?.length === thumb.length &&
			item.thumb.every((byte, index) => byte === thumb[index]);
		if (!sameThumb && item.thumb?.length && !item.deleted) {
			thumb = item.thumb;
			if (preview) {
				URL.revokeObjectURL(preview);
				urls.delete(preview);
			}
			preview = makeUrl(new Blob([item.thumb], { type: "image/webp" }));
		}
		state.update((current) => ({
			...current,
			...item,
			busy: item.busy || loading,
			preview: item.deleted ? "" : preview,
			url: item.deleted ? "" : current.url,
			shown: item.deleted ? false : current.shown,
		}));
	});
	function current() {
		return (
			!disposed &&
			!controller.signal.aborted &&
			get(client).connected &&
			get(client).instanceId === instance &&
			get(client).session.epoch === epoch &&
			!get(state).deleted
		);
	}
	async function run(action) {
		if (!current() || get(state).busy) return null;
		loading = true;
		state.update((value) => ({
			...value,
			busy: true,
			message: "",
			error: false,
		}));
		try {
			return await action();
		} catch (error) {
			if (current())
				state.update((value) => ({
					...value,
					message: error.message,
					error: true,
				}));
			return null;
		} finally {
			loading = false;
			if (current())
				state.update((value) => ({
					...value,
					busy: get(client).media[initialItem.id]?.busy || false,
				}));
		}
	}
	async function receive() {
		if (content) return content;
		const result = await client.command(
			"media.content",
			{ id: initialItem.id },
			{ signal: controller.signal },
		);
		if (!current()) return null;
		content = result;
		const url = makeUrl(result.blob);
		state.update((value) => ({ ...value, url }));
		return result;
	}
	return {
		subscribe: state.subscribe,
		reveal: () =>
			run(async () => {
				const result = await receive();
				if (!result || !current()) return null;
				const preview = result.art
					? makeUrl(
							new Blob([result.art], {
								type: sniffContentType(result.art, ""),
							}),
						)
					: get(state).preview;
				state.update((value) => ({ ...value, shown: true, preview }));
				return get(state).url;
			}),
		download: () =>
			run(async () => {
				if (!(await receive()) || !current()) return;
				const value = get(state);
				await platform.download(
					value.url,
					downloadName(
						value.metadata?.name || initialItem.id,
						value.metadata?.content_type,
					),
				);
			}),
		retag: (tags) =>
			run(() =>
				client.command("media.retag", {
					id: initialItem.id,
					tags,
					metaHash: get(state).metaHash,
				}),
			),
		remove: () =>
			run(() => client.command("media.remove", { id: initialItem.id })),
		dispose() {
			if (disposed) return;
			disposed = true;
			controller.abort();
			unsubscribe();
			revoke();
		},
	};
}
