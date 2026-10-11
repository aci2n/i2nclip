import { createPairingCrypto } from "./crypto.js";

const execute = createPairingCrypto();
let running = false;
self.onmessage = async ({ data }) => {
	if (running) {
		self.postMessage({ id: data.id, error: "Pairing is busy." });
		return;
	}
	running = true;
	try {
		const value = await execute(data.action, data.args);
		self.postMessage({ id: data.id, value });
	} catch {
		// Third-party errors may include received bytes. Never forward them.
		self.postMessage({
			id: data.id,
			error: "Pairing authentication failed. Create a new code.",
		});
	} finally {
		running = false;
	}
};
