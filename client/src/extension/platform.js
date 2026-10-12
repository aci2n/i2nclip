import { createServiceClient } from "../lib/service/client.js";

export const platform = {
	createService() {
		return createServiceClient(() => {
			const port = browser.runtime.connect({ name: "i2nclip-service" });
			return {
				send: (message) => port.postMessage(message),
				listen(listener) {
					port.onMessage.addListener(listener);
					return () => port.onMessage.removeListener(listener);
				},
				onDisconnect(listener) {
					port.onDisconnect.addListener(listener);
					return () => port.onDisconnect.removeListener(listener);
				},
				disconnect: () => port.disconnect(),
			};
		});
	},
	confirm: (message) => globalThis.confirm(message),
	download: (url, filename) =>
		browser.downloads.download({ url, filename, saveAs: true }),
	close: () => window.close(),
};
