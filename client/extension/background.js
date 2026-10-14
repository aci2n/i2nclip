import { checkAppUrl, sendToApp } from "./capture.js";

browser.runtime.onInstalled.addListener(() => {
	browser.contextMenus.create({
		id: "upload",
		title: "Upload to i2nclip",
		contexts: ["image", "audio", "video"],
	});
});

const notify = (message) =>
	browser.notifications.create({
		type: "basic",
		iconUrl: browser.runtime.getURL("icon.svg"),
		title: "i2nclip",
		message,
	});

let capturing = false;
browser.contextMenus.onClicked.addListener(async (info) => {
	if (info.menuItemId !== "upload") {
		return;
	}
	if (capturing) {
		await notify("A file is already being sent to i2nclip.");
		return;
	}
	capturing = true;
	try {
		const { appUrl } = await browser.storage.local.get("appUrl");
		if (!appUrl) {
			await browser.runtime.openOptionsPage();
			throw new Error(
				"Save your web-app URL, then right-click the media again.",
			);
		}
		await sendToApp(browser, checkAppUrl(appUrl), info.srcUrl);
	} catch (error) {
		await notify(error.message);
	} finally {
		capturing = false;
	}
});
