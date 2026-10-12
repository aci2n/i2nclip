import { DEFAULT_SERVER_URL } from "../protocol/server.js";
import { createServiceEngine } from "./engine.js";
import { createRepository } from "./repository.js";

const engine = createServiceEngine({
	repository: createRepository(),
	defaultServerUrl: ["http:", "https:"].includes(self.location.protocol)
		? self.location.origin
		: DEFAULT_SERVER_URL,
	platform: { fetchMedia: ({ srcUrl }, signal) => fetch(srcUrl, { signal }) },
});
self.onconnect = ({ ports: [port] }) => {
	const connection = engine.connect((message) => port.postMessage(message));
	let seen = Date.now();
	const timer = setInterval(() => {
		if (Date.now() - seen > 30_000) {
			clearInterval(timer);
			connection.disconnect();
			port.close();
		}
	}, 5000);
	port.onmessage = ({ data }) => {
		seen = Date.now();
		if (data.type === "detach") {
			clearInterval(timer);
			void connection.receive(data);
			port.close();
		} else void connection.receive(data);
	};
	port.onmessageerror = () => {
		clearInterval(timer);
		connection.disconnect();
		port.close();
	};
	port.start();
};
