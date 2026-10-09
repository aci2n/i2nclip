export function notify(message) {
	return browser.notifications.create({
		type: "basic",
		iconUrl: browser.runtime.getURL("icon.svg"),
		title: "i2nclip",
		message,
	});
}
