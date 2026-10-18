import {
	checkAppUrl,
	handleUploadResult,
	readCaptureContext,
	sendToApp,
} from "./capture.ts";

// Temporary add-on reloads must register the menu even without onInstalled.
void browser.menus
	.removeAll()
	.then(() => {
		browser.menus.create({
			id: "upload",
			title: "Upload to i2nclip",
			contexts: ["image", "audio", "video"],
		});
	})
	.catch(() =>
		console.error("[i2nclip] extension.menu-failed", {
			reason: "menu-registration",
		}),
	);
const notify = (message: string) =>
	browser.notifications
		.create({
			type: "basic",
			iconUrl: browser.runtime.getURL("icon.svg"),
			title: "i2nclip",
			message,
		})
		.catch((error: unknown) => {
			console.warn("[i2nclip] extension.notification-failed", {
				reason: "notification",
			});
			throw error;
		});
browser.runtime.onMessage.addListener((message, sender) =>
	handleUploadResult(browser, message, sender, notify),
);
let capturing = false;
browser.menus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId !== "upload") {
		return;
	}
	if (capturing) {
		console.debug("[i2nclip] extension.capture-rejected", { reason: "busy" });
		await notify(
			"A file is already being sent. Wait for it to finish, then try again.",
		);
		return;
	}
	const instance = crypto.randomUUID();
	console.info("[i2nclip] extension.capture-started", { instance });
	capturing = true;
	try {
		const { appUrl } = await browser.storage.local.get("appUrl");
		if (typeof appUrl !== "string" || !appUrl) {
			await browser.runtime.openOptionsPage();
			throw new Error(
				"Save your i2nclip URL in Preferences, then try the upload again.",
			);
		}
		if (!info.srcUrl) {
			throw new Error("No media URL was provided.");
		}
		const context = await readCaptureContext(browser, info, tab);
		await sendToApp(browser, checkAppUrl(appUrl), info.srcUrl, fetch, context);
	} catch (error) {
		console.error("[i2nclip] extension.capture-failed", {
			instance,
			reason: "capture-or-handoff",
		});
		await notify(error instanceof Error ? error.message : String(error));
	} finally {
		capturing = false;
	}
});
