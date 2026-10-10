import { submitContextUpload } from "../lib/stores/context-upload.js";
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
browser.contextMenus.onClicked.addListener((info, tab) => {
	const source = {
		srcUrl: info.srcUrl || "",
		pageUrl: info.frameUrl || info.pageUrl || "",
		tabId: tab?.id,
		frameId: info.frameId || 0,
	};
	return submitContextUpload(source, info.menuItemId === "tags", platform);
});
