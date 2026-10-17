export function checkServer(serverUrl: string) {
	let url: URL;
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
