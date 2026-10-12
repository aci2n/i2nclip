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
		onCatalog: rebuildMenus,
		openUpload: (id, page, libraryId) =>
			browser.windows.create({
				url: browser.runtime.getURL(
					`${page}.html?id=${id}&library=${libraryId}`,
				),
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
browser.action.onClicked.addListener(() =>
	browser.tabs.create({ url: browser.runtime.getURL("library.html") }),
);
browser.contextMenus.onClicked.addListener((info, tab) => {
	if (!info.srcUrl) return notify("Nothing to upload.");
	const [action, libraryId] = String(info.menuItemId).split(":");
	if (!libraryId || !["upload", "tags"].includes(action)) return;
	return engine
		.contextUpload(
			{
				srcUrl: info.srcUrl,
				pageUrl: info.frameUrl || info.pageUrl || "",
				tabId: tab?.id,
				frameId: info.frameId || 0,
			},
			action === "tags",
			libraryId,
		)
		.catch((error) => notify(error.message));
});

let menuTail = Promise.resolve();
function rebuildMenus(rows) {
	menuTail = menuTail
		.then(async () => {
			await browser.contextMenus.removeAll();
			for (const row of rows) {
				const parentId = `library:${row.id}`;
				browser.contextMenus.create({
					id: parentId,
					title: row.name,
					contexts: ["image", "video", "audio"],
				});
				for (const [action, title] of [
					["upload", "Upload"],
					["tags", "Upload with tags"],
				])
					browser.contextMenus.create({
						id: `${action}:${row.id}`,
						parentId,
						title,
						contexts: ["image", "video", "audio"],
					});
			}
		})
		.catch((error) => notify(error.message));
}
