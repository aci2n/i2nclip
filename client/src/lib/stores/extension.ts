import type { Readable } from "svelte/store";
import { get } from "svelte/store";
import { MAX_FILE_BYTES } from "../api.ts";
import { errorMessage } from "../error.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { document, string } from "../protocol/value.ts";
import type { SessionSnapshot } from "./session.ts";
export interface CaptureEvent {
	source: unknown;
	origin: string;
	data: unknown;
}
export interface ReceiverBrowser {
	location: { origin: string };
	addEventListener(
		type: "message",
		listener: (event: CaptureEvent) => void,
	): void;
	removeEventListener(
		type: "message",
		listener: (event: CaptureEvent) => void,
	): void;
	postMessage(message: unknown, origin: string): void;
}

export interface CaptureSessionState extends SessionSnapshot {
	status: "new" | "locked" | "unlocked";
}
export interface CaptureSession extends Readable<CaptureSessionState> {
	readonly epoch: number;
}
export interface CaptureUploads extends Readable<{ uploading: boolean }> {
	upload(files: File[], extra?: Metadata): Promise<boolean>;
}
interface Capture {
	file: File;
	extra: Metadata;
	token: string;
}

// This root-owned receiver exists only in the tab admitted by the Web Lock.
export function createExtensionReceiver(
	session: CaptureSession,
	uploads: CaptureUploads,
	onupload: () => void,
	browser: ReceiverBrowser = window,
) {
	let pending: Capture | null = null;
	let epoch = session.epoch;
	let disposed = false;
	function rejection() {
		const value = get(session);
		if (value.status === "new" || (value.unlocked && !value.configured)) {
			return "Set up your uploads in i2nclip, then retry.";
		}
		if (value.busy || get(uploads).uploading) {
			return "i2nclip is busy. Wait for the current operation, then retry.";
		}
		return "";
	}
	function complete(capture: Capture, ok: boolean, cancelled = false) {
		browser.postMessage(
			{
				channel: "i2nclip-extension-v1",
				type: "complete",
				token: capture.token,
				result: cancelled ? { ok: false, cancelled: true } : { ok },
			},
			browser.location.origin,
		);
	}
	function discard() {
		const capture = pending;
		pending = null;
		if (capture) {
			complete(capture, false, true);
		}
	}
	function upload(capture = pending) {
		if (
			disposed ||
			!capture ||
			!get(session).unlocked ||
			!get(session).configured ||
			rejection()
		) {
			return false;
		}
		pending = null;
		const own = epoch;
		onupload();
		void uploads.upload([capture.file], capture.extra).then((ok) => {
			if (!disposed) {
				complete(capture, ok, own !== session.epoch);
			}
		});
		return true;
	}
	const unsubscribeSession = session.subscribe((value) => {
		if (value.epoch !== epoch) {
			epoch = value.epoch;
			discard();
		}
		if (value.unlocked && !value.configured) {
			discard();
		}
		upload();
	});
	function receive(event: CaptureEvent) {
		const message =
			event.data && typeof event.data === "object"
				? (event.data as Record<string, unknown>)
				: null;
		if (
			disposed ||
			event.source !== browser ||
			event.origin !== browser.location.origin ||
			message?.channel !== "i2nclip-extension-v1" ||
			(message.type !== "probe" && message.type !== "file") ||
			typeof message.token !== "string" ||
			message.token.length > 80 ||
			!message?.token
		) {
			return;
		}
		let result: { ok: boolean; needsUnlock?: boolean; error?: string };
		try {
			const error =
				rejection() ||
				(pending ? "Unlock i2nclip to finish the pending upload first." : "");
			if (error) {
				throw new Error(error);
			}
			if (message.type === "file") {
				const file = message.file;
				if (!(file instanceof File)) {
					throw new Error("Invalid file handoff.");
				}
				if (file.size > MAX_FILE_BYTES) {
					throw new Error("File is larger than 32 MB.");
				}
				const { sourceUrl, sourceTitle, ...extra } = document(
					message.extra || {},
				);
				const capture = {
					file,
					extra: {
						...extra,
						...(sourceUrl === undefined
							? {}
							: { source_url: string(sourceUrl) }),
						...(sourceTitle === undefined
							? {}
							: { source_title: string(sourceTitle) }),
					},
					token: message.token,
				};
				if (get(session).unlocked) {
					upload(capture);
				} else {
					pending = capture;
				}
			}
			result = { ok: true, needsUnlock: !get(session).unlocked };
		} catch (error) {
			result = { ok: false, error: errorMessage(error) };
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
		dispose() {
			disposed = true;
			browser.removeEventListener("message", receive);
			unsubscribeSession();
			discard();
		},
	};
}
