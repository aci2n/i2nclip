import { thumbnail } from "../media/thumbnail.js";
import { createServiceClient } from "../service/client.js";

export const webPlatform = {
	createService() {
		return createServiceClient(
			() => {
				if (!globalThis.SharedWorker)
					throw new Error("SharedWorker is unavailable in this browser.");
				const worker = new SharedWorker(
					new URL("../service/web-worker.js", import.meta.url),
					{ type: "module", name: "i2nclip-service" },
				);
				const port = worker.port;
				port.start();
				return {
					send: (message) => port.postMessage(message),
					listen(listener) {
						const receive = ({ data }) => listener(data);
						port.addEventListener("message", receive);
						return () => port.removeEventListener("message", receive);
					},
					disconnect: () => port.close(),
					onDisconnect(listener) {
						worker.addEventListener("error", listener);
						port.addEventListener("messageerror", listener);
						return () => {
							worker.removeEventListener("error", listener);
							port.removeEventListener("messageerror", listener);
						};
					},
				};
			},
			{
				helper: (name, payload) =>
					name === "videoThumbnail" ? thumbnail(payload.blob) : null,
			},
		);
	},
	confirm: (message) => globalThis.confirm(message),
	async download(url, filename) {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
	},
	close: () => {},
};
