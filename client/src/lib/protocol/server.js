export const DEFAULT_SERVER_URL = "https://clip.i2n.duckdns.org";

export function checkServer(serverUrl) {
	let url;
	try {
		url = new URL(serverUrl);
	} catch {
		throw new Error("Invalid server URL.");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new Error("Invalid server URL.");
	}
}
