// Serialized by scripting.executeScript: keep this function self-contained.
export function handoff({ appUrl, request, timeout = 5000 }) {
	const app = new URL(appUrl);
	if (location.origin !== app.origin || location.pathname !== app.pathname) {
		return { ok: false, error: "The i2nclip tab navigated away." };
	}
	return new Promise((resolve) => {
		const token = crypto.randomUUID();
		const finish = (result) => {
			clearTimeout(timer);
			window.removeEventListener("message", reply);
			resolve(result);
		};
		const reply = (event) => {
			if (
				event.source === window &&
				event.origin === app.origin &&
				event.data?.channel === "i2nclip-extension-v1" &&
				event.data?.type === "reply" &&
				event.data?.token === token
			) {
				finish(event.data.result);
			}
		};
		const timer = setTimeout(
			() =>
				finish({
					ok: false,
					unavailable: true,
					error: "No reply from i2nclip. Check the app before retrying.",
				}),
			timeout,
		);
		window.addEventListener("message", reply);
		window.postMessage(
			{ ...request, channel: "i2nclip-extension-v1", token },
			app.origin,
		);
	});
}
