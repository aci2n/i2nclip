import { handoff } from "./bridge.js";

// Same plaintext bound as the web upload protocol; checked together in tests.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

export function checkAppUrl(value) {
	const url = new URL(value);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password
	) {
		throw new Error("Use an HTTPS app URL (HTTP is allowed on loopback).");
	}
	url.search = "";
	url.hash = "";
	return url.href;
}

export function matchesApp(value, appUrl) {
	try {
		const url = new URL(value);
		const app = new URL(appUrl);
		return url.origin === app.origin && url.pathname === app.pathname;
	} catch {
		return false;
	}
}

export async function fetchFile(srcUrl, fetcher = fetch) {
	const url = new URL(srcUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new Error(
			"Only public HTTP(S) media can be captured. Use Upload for this file.",
		);
	}
	const signal = AbortSignal.timeout(30_000);
	const response = await fetcher(url.href, { credentials: "omit", signal });
	let reader;
	try {
		if (!response.ok) {
			throw new Error(`Could not fetch the file (${response.status}).`);
		}
		if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) {
			throw new Error("File is larger than 32 MB.");
		}
		reader = response.body?.getReader();
		if (!reader) {
			throw new Error("The media response has no content.");
		}
		const chunks = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) {
				break;
			}
			size += value.length;
			if (size > MAX_FILE_BYTES) {
				throw new Error("File is larger than 32 MB.");
			}
			chunks.push(value);
		}
		const type =
			response.headers.get("content-type")?.split(";")[0].trim() ||
			"application/octet-stream";
		const pathname = new URL(response.url || url.href).pathname;
		let name = pathname.split("/").pop() || "Captured file";
		try {
			name = decodeURIComponent(name);
		} catch {
			// Preserve filenames with literal malformed percent escapes.
		}
		name = name.replace(/[\\/\p{Cc}]/gu, "_").slice(0, 255);
		const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
		const encoded = [];
		for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
			encoded.push(
				btoa(
					String.fromCharCode(...bytes.subarray(offset, offset + 24 * 1024)),
				),
			);
		}
		return { type: "file", name, mime: type, base64: encoded.join("") };
	} finally {
		if (reader) {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		} else {
			await response.body?.cancel().catch(() => {});
		}
	}
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

export async function sendToApp(browser, appUrl, srcUrl, fetcher = fetch) {
	const candidates = (await browser.tabs.query({})).filter((tab) =>
		matchesApp(tab.url, appUrl),
	);
	if (!candidates.length) {
		candidates.push(await browser.tabs.create({ url: appUrl }));
	}
	const request = async (tabId, message, timeout) => {
		const [injection] = await browser.scripting.executeScript({
			target: { tabId },
			func: handoff,
			args: [{ appUrl, request: message, timeout }],
		});
		if (injection?.error) {
			throw new Error(
				injection.error.message || "Could not reach the i2nclip tab.",
			);
		}
		return injection?.result;
	};
	let receiver;
	let ready;
	const deadline = Date.now() + 15_000;
	while (!receiver && Date.now() < deadline) {
		for (const candidate of candidates) {
			const tab = await browser.tabs.get(candidate.id);
			if (!matchesApp(tab.url, appUrl)) {
				continue;
			}
			if (tab.status !== "complete") {
				continue;
			}
			const reply = await request(tab.id, { type: "probe" }, 500);
			if (reply && !reply.unavailable) {
				receiver = tab;
				ready = reply;
				break;
			}
		}
		if (!receiver) {
			await pause();
		}
	}
	if (!receiver) {
		throw new Error("No active i2nclip tab replied. Open the app and retry.");
	}
	await browser.tabs.update(receiver.id, { active: true });
	await browser.windows.update(receiver.windowId, { focused: true });
	if (!ready.ok) {
		throw new Error(ready.error);
	}
	const file = await fetchFile(srcUrl, fetcher);
	const reply = await request(receiver.id, file, 5000);
	if (!reply?.ok) {
		throw new Error(
			reply?.error || "No reply from i2nclip. Check the app before retrying.",
		);
	}
}
