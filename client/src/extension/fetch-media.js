import { MAX_FILE_BYTES } from "../lib/api.js";

// Extension requests can use host permissions; tab requests also cover blob URLs
// and media whose login cookies are scoped to the page or frame.
export async function fetchMedia(
	{ srcUrl, pageUrl, tabId, frameId = 0 },
	signal,
) {
	if (srcUrl.startsWith("blob:") && tabId != null)
		return fetchInTab(tabId, frameId, srcUrl, signal);
	let direct;
	try {
		direct = await fetch(srcUrl, {
			credentials: "include",
			referrer: pageUrl || undefined,
			signal,
		});
		if (direct.ok) return direct;
		if (![401, 403].includes(direct.status))
			throw new Error(`Could not fetch the file (${direct.status}).`);
	} catch (error) {
		signal?.throwIfAborted();
		if (tabId == null || (direct && ![401, 403].includes(direct.status)))
			throw error;
	}
	if (tabId != null) return fetchInTab(tabId, frameId, srcUrl, signal);
	throw new Error(`Could not fetch the file (${direct.status}).`);
}

// Controllers live in the extension's isolated world, never in page state.
async function fetchInTab(tabId, frameId, srcUrl, signal) {
	signal?.throwIfAborted();
	const target = { tabId, frameIds: [frameId] };
	const id = crypto.randomUUID();
	const key = "__i2nclipMediaRequests";
	// Register before starting the request so cancellation cannot race registration.
	await browser.scripting.executeScript({
		target,
		func: (key, id) => {
			globalThis[key] ??= new Map();
			globalThis[key].set(id, new AbortController());
		},
		args: [key, id],
	});
	let rejectAbort;
	const aborted = new Promise((_, reject) => {
		rejectAbort = reject;
	});
	const dispose = () =>
		browser.scripting
			.executeScript({
				target,
				func: (key, id) => {
					globalThis[key]?.get(id)?.abort();
					globalThis[key]?.delete(id);
					if (globalThis[key]?.size === 0) delete globalThis[key];
				},
				args: [key, id],
			})
			.catch(() => {}); // A closed/navigated frame has already disposed its work.
	const abort = () => {
		rejectAbort(signal.reason);
		void dispose();
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) abort();
		const request = signal?.aborted
			? aborted
			: browser.scripting.executeScript({
					target,
					// executeScript serializes this function: keep it self-contained.
					func: async (key, id, url, max) => {
						const controller = globalThis[key]?.get(id);
						if (!controller) return { error: "Media request cancelled." };
						let reader;
						try {
							const response = await fetch(url, {
								credentials: "include",
								signal: controller.signal,
							});
							if (!response.ok) {
								await response.body?.cancel();
								return {
									error: `Could not fetch the file (${response.status}).`,
								};
							}
							reader = response.body?.getReader();
							const chunks = [];
							let size = 0;
							while (reader) {
								const { done, value } = await reader.read();
								controller.signal.throwIfAborted();
								if (done) break;
								size += value.length;
								if (size > max) return { error: "File is larger than 32 MB." };
								chunks.push(value);
							}
							const bytes = new Uint8Array(size);
							let offset = 0;
							for (const chunk of chunks) {
								bytes.set(chunk, offset);
								offset += chunk.length;
							}
							return {
								bytes,
								type: response.headers.get("content-type") || "",
							};
						} finally {
							try {
								await reader?.cancel();
							} finally {
								reader?.releaseLock();
								globalThis[key]?.delete(id);
								if (globalThis[key]?.size === 0) delete globalThis[key];
							}
						}
					},
					args: [key, id, srcUrl, MAX_FILE_BYTES],
				});
		const [injected] = await Promise.race([request, aborted]);
		signal?.throwIfAborted();
		const result = injected?.result;
		if (!result?.bytes)
			throw new Error(
				result?.error || "Could not fetch the file from this tab.",
			);
		return new Response(result.bytes, {
			headers: { "content-type": result.type },
		});
	} finally {
		signal?.removeEventListener("abort", abort);
		await dispose();
	}
}
