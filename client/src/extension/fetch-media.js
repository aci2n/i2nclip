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

async function fetchInTab(tabId, frameId, srcUrl, signal) {
	signal?.throwIfAborted();
	const [injected] = await browser.scripting.executeScript({
		target: { tabId, frameIds: [frameId] },
		// executeScript serializes this function: keep it self-contained.
		func: async (url, max) => {
			const response = await fetch(url, { credentials: "include" });
			if (!response.ok)
				return { error: `Could not fetch the file (${response.status}).` };
			const reader = response.body.getReader();
			const chunks = [];
			let size = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > max) return { error: "File is larger than 32 MB." };
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			return { bytes, type: response.headers.get("content-type") || "" };
		},
		args: [srcUrl, MAX_FILE_BYTES],
	});
	signal?.throwIfAborted();
	const result = injected?.result;
	if (!result?.bytes)
		throw new Error(result?.error || "Could not fetch the file from this tab.");
	return new Response(result.bytes, {
		headers: { "content-type": result.type },
	});
}
