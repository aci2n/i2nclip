// Browser-test host: real engine and IndexedDB, with only Firefox platform APIs shimmed.
import { DEFAULT_SERVER_URL } from "../src/lib/protocol/server.js";
import { createServiceEngine } from "../src/lib/service/engine.js";
import { createRepository } from "../src/lib/service/repository.js";
import { sendUpload } from "../src/lib/media/upload.js";
let uploadGate, releaseUploads;
const repository = createRepository();
// Exercise the capability fallback used by SharedWorkers without nested Worker.
Object.defineProperty(globalThis, "Worker", {
	value: undefined,
	configurable: true,
});
const engine = createServiceEngine({
	repository,
	defaultServerUrl: DEFAULT_SERVER_URL,
	upload: async (options) => {
		await uploadGate;
		options.signal.throwIfAborted();
		return sendUpload(options);
	},
	platform: {
		fetchMedia: ({ srcUrl }, signal) => fetch(srcUrl, { signal }),
		notify: () => {},
	},
});
self.onconnect = ({ ports: [port] }) => {
	const connection = engine.connect((message) => port.postMessage(message));
	port.onmessage = async ({ data }) => {
		if (
			data.type === "test.pauseUploads" ||
			data.type === "test.resumeUploads"
		) {
			if (data.type === "test.pauseUploads")
				uploadGate = new Promise((resolve) => (releaseUploads = resolve));
			else {
				releaseUploads?.();
				uploadGate = undefined;
			}
			port.postMessage({
				type: "test.reply",
				requestId: data.requestId,
				value: true,
			});
			return;
		}
		if (data.type === "test.context") {
			await engine.contextUpload(data.source, data.withTags, data.libraryId);
			port.postMessage({
				type: "test.reply",
				requestId: data.requestId,
				value: true,
			});
			return;
		}
		if (data.type === "test.restart") {
			engine.dispose();
			self.close();
			return;
		}
		await connection.receive(data);
	};
	port.start();
};
