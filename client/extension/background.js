import {
	checkAppUrl,
	closeUploadedPopup,
	readCaptureContext,
	sendToApp,
} from "./capture.js";

browser.runtime.onMessage.addListener((message, sender) =>
	closeUploadedPopup(browser, message, sender),
);

// Temporary add-on reloads must register the menu even without onInstalled.
void browser.menus.removeAll().then(() => {
	browser.menus.create({
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
browser.menus.onClicked.addListener(async (info, tab) => {
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
		const context = await readCaptureContext(browser, info, tab);
		await sendToApp(browser, checkAppUrl(appUrl), info.srcUrl, fetch, context);
	} catch (error) {
		await notify(error.message);
	} finally {
		capturing = false;
	}
});
