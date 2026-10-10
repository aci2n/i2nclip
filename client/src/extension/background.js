import { get } from "svelte/store";
import { sendUpload } from "../lib/media/upload.js";
import { createSession } from "../lib/stores/session.js";
import { platform } from "./platform.js";

browser.contextMenus.removeAll().then(() => {
	for (const [id, title] of [
		["upload", "Upload to i2nclip"],
		["tags", "Upload to i2nclip with tags"],
	]) {
		browser.contextMenus.create({
			id,
			title,
			contexts: ["image", "video", "audio"],
		});
	}
});
browser.action.onClicked.addListener(() =>
	browser.tabs.create({ url: browser.runtime.getURL("library.html") }),
);
browser.contextMenus.onClicked.addListener(async (info, tab) => {
	const source = {
		srcUrl: info.srcUrl || "",
		pageUrl: info.frameUrl || info.pageUrl || "",
		tabId: tab?.id,
		frameId: info.frameId || 0,
	};
	if (!source.srcUrl) {
		await platform.notify("Nothing to upload.");
		return;
	}
	const session = createSession(platform);
	const controller = new AbortController();
	let unsubscribe = () => {};
	try {
		await session.ready;
		if (info.menuItemId === "tags" || !get(session).privateKey) {
			const id = crypto.randomUUID();
			source.id = id;
			await platform.session.set({ [`upload:${id}`]: source });
			const page = info.menuItemId === "tags" ? "upload" : "unlock";
			await browser.windows.create({
				url: browser.runtime.getURL(`${page}.html?id=${id}`),
				type: "popup",
				width: 440,
				height: 640,
			});
		} else {
			const credentials = session.credentials();
			unsubscribe = session.subscribe((value) => {
				if (
					value.privateKey !== credentials.privateKey ||
					value.serverUrl !== credentials.serverUrl
				)
					controller.abort();
			});
			await sendUpload(
				source,
				credentials,
				platform,
				"",
				undefined,
				controller.signal,
			);
			await platform.notify("Uploaded.");
		}
	} catch (error) {
		await platform.notify(
			controller.signal.aborted
				? "Library changed. Upload cancelled."
				: error.message || "Upload failed.",
		);
	} finally {
		unsubscribe();
		session.dispose();
	}
});
