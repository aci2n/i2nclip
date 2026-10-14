import { get, writable } from "svelte/store";
import { MAX_FILE_BYTES } from "../api.js";

// This root-owned receiver exists only in the tab admitted by the Web Lock.
export function createExtensionReceiver(
	session,
	library,
	onupload,
	browser = window,
) {
	const state = writable({ name: "", canUpload: false });
	let pending = null;
	let epoch = session.epoch;
	let disposed = false;
	function rejection() {
		const value = get(session);
		if (value.status === "new" || (value.unlocked && !value.configured)) {
			return "Set up your library in i2nclip, then retry.";
		}
		if (value.busy || get(library).uploading) {
			return "i2nclip is busy. Wait for the current operation, then retry.";
		}
		return "";
	}
	function publish() {
		const value = get(session);
		state.set({
			name: pending?.name || "",
			canUpload: Boolean(
				pending && value.unlocked && value.configured && !rejection(),
			),
		});
	}
	function cancel() {
		pending = null;
		publish();
	}
	function upload(file = pending) {
		if (
			disposed ||
			!file ||
			!get(session).unlocked ||
			!get(session).configured ||
			rejection()
		) {
			return false;
		}
		pending = null;
		publish();
		onupload();
		void library.upload([file]);
		return true;
	}
	const unsubscribeSession = session.subscribe((value) => {
		if (value.epoch !== epoch) {
			epoch = value.epoch;
			pending = null;
		}
		publish();
	});
	const unsubscribeLibrary = library.subscribe(publish);
	function receive(event) {
		const message = event.data;
		if (
			disposed ||
			event.source !== browser ||
			event.origin !== browser.location.origin ||
			message?.channel !== "i2nclip-extension-v1" ||
			!["probe", "file"].includes(message.type) ||
			typeof message.token !== "string" ||
			message.token.length > 80 ||
			!message.token
		) {
			return;
		}
		let result;
		try {
			const error =
				rejection() ||
				(pending ? "Upload or cancel the pending file in i2nclip first." : "");
			if (error) {
				throw new Error(error);
			}
			if (message.type === "file") {
				if (
					typeof message.name !== "string" ||
					!message.name ||
					message.name.length > 255 ||
					/[\\/\p{Cc}]/u.test(message.name) ||
					typeof message.mime !== "string" ||
					message.mime.length > 255 ||
					!/^[-\w.+]+\/[-\w.+]+$/.test(message.mime) ||
					typeof message.base64 !== "string"
				) {
					throw new Error("Invalid file handoff.");
				}
				const encoded = message.base64;
				if (encoded.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) {
					throw new Error("File is larger than 32 MB.");
				}
				if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
					throw new Error("Invalid file handoff.");
				}
				const padding = encoded.endsWith("==")
					? 2
					: encoded.endsWith("=")
						? 1
						: 0;
				if ((encoded.length / 4) * 3 - padding > MAX_FILE_BYTES) {
					throw new Error("File is larger than 32 MB.");
				}
				const decoded = atob(encoded);
				const bytes = new Uint8Array(decoded.length);
				for (let index = 0; index < decoded.length; index++) {
					bytes[index] = decoded.charCodeAt(index);
				}
				const file = new File([bytes], message.name, { type: message.mime });
				if (get(session).unlocked) {
					upload(file);
				} else {
					pending = file;
					publish();
				}
			}
			result = { ok: true };
		} catch (error) {
			result = { ok: false, error: error.message };
		}
		browser.postMessage(
			{
				channel: "i2nclip-extension-v1",
				type: "reply",
				token: message.token,
				result,
			},
			browser.location.origin,
		);
	}
	browser.addEventListener("message", receive);
	return {
		subscribe: state.subscribe,
		upload: () => upload(),
		cancel,
		dispose() {
			disposed = true;
			browser.removeEventListener("message", receive);
			unsubscribeSession();
			unsubscribeLibrary();
			cancel();
		},
	};
}
