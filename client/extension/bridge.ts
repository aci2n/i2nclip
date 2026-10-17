import type { BridgeReply } from "./types.d.ts";
// Serialized by scripting.executeScript: keep this function self-contained.
export function installBridge() {
	if (globalThis.i2nclipBridgeInstalled) {
		return;
	}
	globalThis.i2nclipBridgeInstalled = true;
	browser.runtime.onMessage.addListener((input: unknown, sender) => {
		const message =
			input && typeof input === "object"
				? (input as Record<string, unknown>)
				: {};
		if (
			sender.id !== browser.runtime.id ||
			message?.channel !== "i2nclip-extension-v1"
		) {
			return;
		}
		if (
			typeof message.appUrl !== "string" ||
			!message.request ||
			typeof message.request !== "object"
		) {
			return;
		}
		const appUrl = message.appUrl;
		const request = message.request as Record<string, unknown>;
		if (request.type !== "probe" && request.type !== "file") {
			return;
		}
		const timeout =
			typeof message.timeout === "number" ? message.timeout : 5000;
		const app = new URL(appUrl);
		if (location.origin !== app.origin || location.pathname !== app.pathname) {
			return Promise.resolve({
				ok: false,
				error:
					"The i2nclip tab is now on another page. Open i2nclip and try again.",
			});
		}
		return new Promise<BridgeReply>((resolve) => {
			const token = crypto.randomUUID();
			let accepted = false;
			let replied = false;
			const cleanup = () => {
				clearTimeout(timer);
				window.removeEventListener("message", reply);
				window.removeEventListener("pagehide", leave);
			};
			const finish = (result: BridgeReply) => {
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
			function isReply(value: unknown): value is BridgeReply {
				if (
					!value ||
					typeof value !== "object" ||
					!("ok" in value) ||
					typeof value.ok !== "boolean"
				) {
					return false;
				}
				return (
					(!("error" in value) || typeof value.error === "string") &&
					(!("unavailable" in value) ||
						typeof value.unavailable === "boolean") &&
					(!("needsUnlock" in value) || typeof value.needsUnlock === "boolean")
				);
			}
			const reply = (event: MessageEvent<unknown>) => {
				const data =
					event.data && typeof event.data === "object"
						? (event.data as Record<string, unknown>)
						: {};
				const result =
					data.result && typeof data.result === "object"
						? (data.result as Record<string, unknown>)
						: {};
				if (
					event.source === window &&
					event.origin === app.origin &&
					data.channel === "i2nclip-extension-v1" &&
					data.token === token
				) {
					if (data.type === "reply" && isReply(result)) {
						finish(result);
					} else if (data.type === "complete" && accepted) {
						cleanup();
						if (!result.cancelled) {
							void browser.runtime
								.sendMessage({
									type: "upload-complete",
									ok: result.ok === true,
									name:
										request.file &&
										typeof request.file === "object" &&
										"name" in request.file &&
										typeof request.file.name === "string"
											? request.file.name
											: "",
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
