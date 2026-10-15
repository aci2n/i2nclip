import { installBridge } from "./bridge.js";

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
		throw new Error(
			"Use your i2nclip HTTPS URL. HTTP is allowed for localhost, 127.0.0.1, or [::1].",
		);
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

// Serialized into the clicked frame. Read only the exact context-menu target.
export function captureDetails(targetElementId) {
	const element =
		targetElementId == null
			? null
			: browser.menus.getTargetElement(targetElementId);
	const labels = [
		element?.getAttribute("alt"),
		element?.getAttribute("title"),
		element?.getAttribute("aria-label"),
	];
	return {
		label: labels.find((text) => text?.trim()) || "",
		title: document.title,
		url: location.href,
	};
}

export async function readCaptureContext(browser, info, tab) {
	const fallback = {
		title: tab?.title || "",
		url: info.frameUrl || info.pageUrl || tab?.url || "",
	};
	if (tab?.id == null) {
		return fallback;
	}
	try {
		const [injection] = await browser.scripting.executeScript({
			target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
			func: captureDetails,
			args: [info.targetElementId ?? null],
		});
		return injection?.result || fallback;
	} catch {
		return fallback;
	}
}

export function captureName(context, originalName, type) {
	let label = [context.label, context.title].find((text) => text?.trim()) || "";
	if (!label && context.url) {
		const page = new URL(context.url);
		label = page.host + page.pathname + page.search + page.hash;
		try {
			label = decodeURIComponent(label);
		} catch {
			// A malformed URL escape still provides useful page context.
		}
	}
	label = (label || originalName)
		.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "");
	const extension =
		{
			"image/jpeg": "jpg",
			"image/png": "png",
			"image/gif": "gif",
			"image/webp": "webp",
			"image/avif": "avif",
			"image/svg+xml": "svg",
			"video/mp4": "mp4",
			"video/webm": "webm",
			"audio/mpeg": "mp3",
			"audio/ogg": "ogg",
			"audio/wav": "wav",
			"audio/x-wav": "wav",
		}[type] ||
		originalName.match(/\.([a-z0-9]{1,8})$/i)?.[1] ||
		"";
	const suffix = extension ? `.${extension}` : "";
	if (suffix && label.toLowerCase().endsWith(suffix.toLowerCase())) {
		label = label.slice(0, -suffix.length);
	}
	return (
		(label || "Captured media").slice(0, 255 - suffix.length).trim() + suffix
	);
}

export async function fetchFile(srcUrl, fetcher = fetch, context = {}) {
	const url = new URL(srcUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new Error(
			"Only public HTTP(S) media is supported. Save the file, then use Upload in i2nclip.",
		);
	}
	const signal = AbortSignal.timeout(30_000);
	const response = await fetcher(url.href, { credentials: "omit", signal });
	let reader;
	try {
		if (!response.ok) {
			throw new Error(`Could not download the file (HTTP ${response.status}).`);
		}
		if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) {
			throw new Error("File is larger than 32 MB.");
		}
		reader = response.body?.getReader();
		if (!reader) {
			throw new Error(
				"The file could not be read. Save it, then use Upload in i2nclip.",
			);
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
		return new File(chunks, captureName(context, name, type), { type });
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

export async function sendToApp(
	browser,
	appUrl,
	srcUrl,
	fetcher = fetch,
	context = {},
) {
	const app = new URL(appUrl);
	// Firefox match patterns omit ports; matchesApp checks the exact origin below.
	const pattern = `${app.protocol}//${app.hostname}${app.pathname}*`;
	const candidates = (await browser.tabs.query({ url: pattern })).filter(
		(tab) => matchesApp(tab.url, appUrl),
	);
	if (!candidates.length) {
		candidates.push(await browser.tabs.create({ url: appUrl, active: false }));
	}
	const request = async (tabId, message, timeout) => {
		await browser.scripting.executeScript({
			target: { tabId },
			func: installBridge,
		});
		return browser.tabs.sendMessage(
			tabId,
			{ channel: "i2nclip-extension-v1", appUrl, request: message, timeout },
			{ frameId: 0 },
		);
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
		throw new Error("Could not reach i2nclip. Open the app and try again.");
	}
	if (!ready.ok) {
		throw new Error(ready.error);
	}
	const file = await fetchFile(srcUrl, fetcher, context);
	const extra = {};
	if (context.url) {
		const source = new URL(context.url);
		if (["http:", "https:"].includes(source.protocol)) {
			source.username = "";
			source.password = "";
			extra.sourceUrl = source.href;
			if (context.title?.trim()) {
				extra.sourceTitle = context.title.trim();
			}
		}
	}
	const reply = await request(receiver.id, { type: "file", file, extra }, 5000);
	if (!reply?.ok) {
		throw new Error(
			reply?.error ||
				"No response from i2nclip. Check the app before trying again.",
		);
	}
	if (reply.needsUnlock) {
		await browser.tabs.update(receiver.id, { active: true });
		await browser.windows.update(receiver.windowId, { focused: true });
	}
}

export async function handleUploadResult(browser, message, sender, notify) {
	if (
		message?.type !== "upload-complete" ||
		sender.id !== browser.runtime.id ||
		sender.frameId !== 0 ||
		!sender.tab ||
		typeof message.ok !== "boolean" ||
		typeof message.name !== "string"
	) {
		return;
	}
	const appUrl = message.appUrl;
	if (!matchesApp(sender.url, appUrl)) {
		return;
	}
	await notify(
		message.ok
			? `Uploaded ${message.name}.`
			: `Upload failed for ${message.name}. Open i2nclip for details.`,
	);
}
