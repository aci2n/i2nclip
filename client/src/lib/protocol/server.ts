const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** HTTPS everywhere, with plain HTTP only for loopback development servers. */
export function checkServer(serverUrl: string) {
	let url: URL;
	try {
		url = new URL(serverUrl);
	} catch {
		throw new Error("Invalid server URL.");
	}
	if (url.username || url.password) {
		throw new Error("Invalid server URL.");
	}
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && LOOPBACK.includes(url.hostname))
	) {
		throw new Error(
			"Use an HTTPS server URL. HTTP is allowed for localhost, 127.0.0.1, or [::1].",
		);
	}
}
