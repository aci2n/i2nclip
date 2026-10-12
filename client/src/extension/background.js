import { DEFAULT_SERVER_URL } from "../lib/protocol/server.js";
import { createServiceEngine } from "../lib/service/engine.js";
import { createRepository } from "../lib/service/repository.js";
import { fetchMedia } from "./fetch-media.js";
import { notify } from "./notify.js";

const engine = createServiceEngine({
	repository: createRepository(),
	defaultServerUrl: DEFAULT_SERVER_URL,
	platform: {
		fetchMedia,
		notify,
		videoThumbnail: true,
		openUpload: (id, page) =>
			browser.windows.create({
				url: browser.runtime.getURL(`${page}.html?id=${id}`),
				type: "popup",
				width: 440,
				height: 640,
			}),
	},
});
engine.ready.catch((error) => notify(error.message));
browser.runtime.onConnect.addListener((port) => {
	if (port.name !== "i2nclip-service" || port.sender?.id !== browser.runtime.id)
		return;
	const connection = engine.connect((message) => port.postMessage(message));
	port.onMessage.addListener((message) => {
		void connection.receive(message);
	});
	port.onDisconnect.addListener(connection.disconnect);
});
browser.contextMenus.removeAll().then(() => {
	for (const [id, title] of [
		["upload", "Upload to i2nclip"],
		["tags", "Upload to i2nclip with tags"],
	])
		browser.contextMenus.create({
			id,
			title,
			contexts: ["image", "video", "audio"],
		});
});
browser.action.onClicked.addListener(() =>
	browser.tabs.create({ url: browser.runtime.getURL("library.html") }),
);
browser.contextMenus.onClicked.addListener((info, tab) => {
	if (!info.srcUrl) return notify("Nothing to upload.");
	return engine
		.contextUpload(
			{
				srcUrl: info.srcUrl,
				pageUrl: info.frameUrl || info.pageUrl || "",
				tabId: tab?.id,
				frameId: info.frameId || 0,
			},
			info.menuItemId === "tags",
		)
		.catch((error) => notify(error.message));
});
