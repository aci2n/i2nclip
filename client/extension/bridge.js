// Serialized by scripting.executeScript: keep this function self-contained.
export function installBridge() {
	if (globalThis.i2nclipBridgeInstalled) {
		return;
	}
	globalThis.i2nclipBridgeInstalled = true;
	browser.runtime.onMessage.addListener((message, sender) => {
		if (
			sender.id !== browser.runtime.id ||
			message?.channel !== "i2nclip-extension-v1"
		) {
			return;
		}
		const { appUrl, request, timeout = 5000 } = message;
		const app = new URL(appUrl);
		if (location.origin !== app.origin || location.pathname !== app.pathname) {
			return Promise.resolve({
				ok: false,
				error:
					"The i2nclip tab is now on another page. Open i2nclip and try again.",
			});
		}
		return new Promise((resolve) => {
			const token = crypto.randomUUID();
			let accepted = false;
			let replied = false;
			const cleanup = () => {
				clearTimeout(timer);
				window.removeEventListener("message", reply);
				window.removeEventListener("pagehide", leave);
			};
			const finish = (result) => {
				if (replied) {
					return;
				}
				replied = true;
				accepted = result?.ok === true && request.type === "file";
				clearTimeout(timer);
				if (!accepted) {
					cleanup();
				}
				resolve(result);
			};
			const leave = () => {
				if (!replied) {
					finish({
						ok: false,
						unavailable: true,
						error:
							"The i2nclip tab was closed or changed pages. Open i2nclip and try again.",
					});
				} else {
					cleanup();
				}
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
						if (!event.data.result?.cancelled) {
							void browser.runtime
								.sendMessage({
									type: "upload-complete",
									ok: event.data.result?.ok === true,
									name: request.file.name,
									appUrl,
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
						error:
							"No response from i2nclip. Check the app before trying again.",
					}),
				timeout,
			);
			window.addEventListener("message", reply);
			window.addEventListener("pagehide", leave, { once: true });
			window.postMessage(
				{ ...request, channel: "i2nclip-extension-v1", token },
				app.origin,
			);
		});
	});
}
