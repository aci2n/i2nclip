// Browser-test host: real engine and IndexedDB, with only Firefox platform APIs shimmed.
import { DEFAULT_SERVER_URL } from "../src/lib/protocol/server.js";
import { createServiceEngine } from "../src/lib/service/engine.js";
import { createRepository } from "../src/lib/service/repository.js";
const repository = createRepository();
const engine = createServiceEngine({
	repository,
	defaultServerUrl: DEFAULT_SERVER_URL,
	platform: {
		fetchMedia: ({ srcUrl }, signal) => fetch(srcUrl, { signal }),
		notify: () => {},
	},
});
self.onconnect = ({ ports: [port] }) => {
	const connection = engine.connect((message) => port.postMessage(message));
	port.onmessage = async ({ data }) => {
		if (data.type === "test.config") {
			port.postMessage({
				type: "test.reply",
				requestId: data.requestId,
				value: await repository.getConfig(),
			});
			return;
		}
		if (data.type === "test.context") {
			await engine.contextUpload(data.source, data.withTags);
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
