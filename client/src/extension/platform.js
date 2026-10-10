import { fetchMedia } from "./fetch-media.js";
import { notify } from "./notify.js";

export const platform = {
	confirm: (message) => globalThis.confirm(message),
	local: browser.storage.local,
	session: browser.storage.session,
	subscribe(listener) {
		const changed = (changes, area) => {
			if (
				(area === "local" &&
					["serverUrl", "wrappedKey", "pendingRegistration"].some(
						(key) => key in changes,
					)) ||
				(area === "session" && "privateKey" in changes)
			)
				listener();
		};
		browser.storage.onChanged.addListener(changed);
		return () => browser.storage.onChanged.removeListener?.(changed);
	},
	download: (url, filename) =>
		browser.downloads.download({ url, filename, saveAs: true }),
	fetchMedia,
	notify,
	openUpload: (id, page) =>
		browser.windows.create({
			url: browser.runtime.getURL(`${page}.html?id=${id}`),
			type: "popup",
			width: 440,
			height: 640,
		}),
	close: () => window.close(),
};
