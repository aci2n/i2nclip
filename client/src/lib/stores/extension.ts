import type { Readable } from "svelte/store";
import { get } from "svelte/store";
import { checkFileSize } from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { canConvertImage, canConvertVideo } from "../media/options.ts";
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
export interface CaptureSession extends Readable<CaptureSessionState> {}
export interface CaptureUploads
	extends Readable<{ uploading: boolean; pending: readonly unknown[] }> {
	upload(files: File[], extra?: Metadata): Promise<boolean>;
	checkFile(file: File): void;
}
interface Capture {
	operation: number;
	file: File;
	extra: Metadata;
	token: string;
}

// Each app tab owns its receiver and at most one pending capture.
export function createExtensionReceiver(
	session: CaptureSession,
	getUploads: () => CaptureUploads | null,
	onupload: () => void,
	browser: ReceiverBrowser = window,
) {
	const log = createLog("extension-receiver");
	log.debug("created");
	let pending: Capture | null = null;

	let disposed = false;
	function rejection() {
		const value = get(session);
		const uploads = getUploads();
		if (value.status === "new" || (value.unlocked && !value.configured)) {
			return "Set up your uploads in i2nclip, then retry.";
		}
		if (
			value.busy ||
			(uploads ? get(uploads).uploading || get(uploads).pending.length : false)
		) {
			return "i2nclip is busy. Wait for the current operation, then retry.";
		}
		return "";
	}
	function complete(capture: Capture, ok: boolean, cancelled = false) {
		log.debug("completed", { operation: capture.operation, ok, cancelled });
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
			log.debug("pending-discarded", { operation: capture.operation });
			complete(capture, false, true);
		}
	}
	function upload(capture: Capture) {
		log.info("upload-started", { operation: capture.operation });
		pending = null;
		const signal = get(session).signal;
		onupload();
		const uploads = getUploads();
		if (!uploads) {
			complete(capture, false, true);
			return;
		}
		void uploads.upload([capture.file], capture.extra).then((ok) => {
			if (!disposed) {
				complete(capture, ok, signal.aborted);
			}
		});
	}
	let lifetime: AbortSignal | null = null;
	const unsubscribeSession = session.subscribe((value) => {
		if (value.signal !== lifetime) {
			lifetime?.removeEventListener("abort", discard);
			lifetime = value.signal;
			lifetime.addEventListener("abort", discard, { once: true });
		}
		if (value.unlocked && !value.configured) {
			discard();
		}
		if (pending && value.unlocked && !rejection()) {
			log.debug("pending-resumed", { operation: pending.operation });
			upload(pending);
		}
	});

	function receive(event: CaptureEvent) {
		const message =
			event.data && typeof event.data === "object"
				? (event.data as Record<string, unknown>)
				: null;
		if (
			event.source !== browser ||
			event.origin !== browser.location.origin ||
			message?.channel !== "i2nclip-extension-v1" ||
			(message.type !== "probe" && message.type !== "file") ||
			typeof message.token !== "string" ||
			message.token.length > 80 ||
			!message.token
		) {
			return;
		}
		const operation = log.operation();
		log.debug("received", { operation, type: message.type });
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
				const uploads = getUploads();
				if (uploads) {
					uploads.checkFile(file);
				} else if (!canConvertImage(file) && !canConvertVideo(file)) {
					checkFileSize(file.size);
				}
				const { sourceUrl, sourceTitle, ...extra } = document(
					message.extra || {},
				);
				const capture = {
					operation,
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
					log.debug("pending-unlock", { operation });
				}
			}
			result = { ok: true, needsUnlock: !get(session).unlocked };
		} catch (error) {
			log.warn("rejected", {
				operation,
				type: message.type,
				...failureFields(error),
			});
			result = { ok: false, error: errorMessage(error) };
		}
		log.debug("reply-sent", {
			operation,
			ok: result.ok,
			needsUnlock: result.needsUnlock,
		});
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
			log.debug("disposed");
			disposed = true;
			browser.removeEventListener("message", receive);
			unsubscribeSession();
			lifetime?.removeEventListener("abort", discard);
			discard();
		},
	};
}
