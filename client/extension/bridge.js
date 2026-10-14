// Serialized by scripting.executeScript: keep this function self-contained.
export function handoff({
	appUrl,
	request,
	timeout = 5000,
	temporaryWindowId,
}) {
	const app = new URL(appUrl);
	if (location.origin !== app.origin || location.pathname !== app.pathname) {
		return { ok: false, error: "The i2nclip tab navigated away." };
	}
	return new Promise((resolve) => {
		const token = crypto.randomUUID();
		let accepted = false;
		let replied = false;
		const cleanup = () => {
			clearTimeout(timer);
			window.removeEventListener("message", reply);
			window.removeEventListener("pagehide", cleanup);
		};
		const finish = (result) => {
			if (replied) {
				return;
			}
			replied = true;
			accepted =
				result?.ok === true &&
				request.closeWhenDone === true &&
				Number.isInteger(temporaryWindowId);
			clearTimeout(timer);
			if (!accepted) {
				cleanup();
			}
			resolve(result);
		};
		const reply = (event) => {
			if (
				event.source === window &&
				event.origin === app.origin &&
				event.data?.channel === "i2nclip-extension-v1" &&
				event.data?.token === token
			) {
				if (event.data.type === "reply") {
					finish(event.data.result);
				} else if (event.data.type === "complete" && accepted) {
					cleanup();
					if (event.data.result?.ok === true) {
						void browser.runtime
							.sendMessage({
								type: "upload-complete",
								windowId: temporaryWindowId,
							})
							.catch(() => {});
					}
				}
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
		window.addEventListener("pagehide", cleanup, { once: true });
		window.postMessage(
			{ ...request, channel: "i2nclip-extension-v1", token },
			app.origin,
		);
	});
}
