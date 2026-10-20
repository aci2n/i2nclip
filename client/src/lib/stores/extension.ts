import type { Readable } from "svelte/store";
import { get } from "svelte/store";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { contentShape } from "../protocol/content.ts";
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

export interface CaptureUploads extends Readable<{ uploading: boolean }> {
	upload(files: File[], extra?: Metadata): Promise<boolean>;
}

interface Capture {
	operation: number;
	file: File;
	extra: Metadata;
	token: string;
}
export function createExtensionReceiver(
	session: CaptureSession,
	getUploads: () => CaptureUploads | null,
	onupload: () => void,
	browser: ReceiverBrowser = window,
): Pick<ExtensionReceiverStoreImpl, keyof ExtensionReceiverStoreImpl> {
	return new ExtensionReceiverStoreImpl(session, getUploads, onupload, browser);
}

class ExtensionReceiverStoreImpl {
	private readonly session: CaptureSession;
	private readonly getUploads: () => CaptureUploads | null;
	private readonly onupload: () => void;
	private readonly browser: ReceiverBrowser;
	private readonly log: ReturnType<typeof createLog>;
	private pending: Capture | null;
	private disposed: boolean;
	private lifetime: AbortSignal | null;
	private discard: () => void;
	private receive: (event: CaptureEvent) => void;
	private unsubscribeSession: () => void = () => {};
	readonly dispose = this.disposeReceiver.bind(this);

	constructor(
		session: CaptureSession,
		getUploads: () => CaptureUploads | null,
		onupload: () => void,
		browser: ReceiverBrowser = window,
	) {
		this.session = session;
		this.getUploads = getUploads;
		this.onupload = onupload;
		this.browser = browser;
		this.log = createLog("extension-receiver");
		this.log.debug("created");
		this.pending = null;
		this.disposed = false;
		this.lifetime = null;
		this.discard = this.discardCapture.bind(this);
		this.receive = this.receiveCapture.bind(this);
		try {
			this.unsubscribeSession = session.subscribe((value) =>
				this.syncCaptureSession(value),
			);
			browser.addEventListener("message", this.receive);
		} catch (error) {
			this.disposeReceiver();
			throw error;
		}
	}

	private captureRejection() {
		const value = get(this.session);
		const uploads = this.getUploads();
		if (value.status === "new" || (value.unlocked && !value.configured)) {
			return "Set up your uploads in i2nclip, then retry.";
		}
		if (value.busy || (uploads ? get(uploads).uploading : false)) {
			return "i2nclip is busy. Wait for the current operation, then retry.";
		}
		return "";
	}

	private completeCapture(capture: Capture, ok: boolean, cancelled = false) {
		this.log.debug("completed", {
			operation: capture.operation,
			ok,
			cancelled,
		});
		this.browser.postMessage(
			{
				channel: "i2nclip-extension-v1",
				type: "complete",
				token: capture.token,
				result: cancelled ? { ok: false, cancelled: true } : { ok },
			},
			this.browser.location.origin,
		);
	}

	private discardCapture() {
		const capture = this.pending;
		this.pending = null;
		if (capture) {
			this.log.debug("pending-discarded", { operation: capture.operation });
			this.completeCapture(capture, false, true);
		}
	}

	private uploadCapture(capture: Capture) {
		this.log.info("upload-started", { operation: capture.operation });
		this.pending = null;
		const signal = get(this.session).signal;
		this.onupload();
		const uploads = this.getUploads();
		if (!uploads) {
			this.completeCapture(capture, false, true);
			return;
		}
		void uploads
			.upload([capture.file], capture.extra)
			.then((ok) => this.captureUploaded(capture, signal, ok));
	}

	private receiveCapture(event: CaptureEvent) {
		const message =
			event.data && typeof event.data === "object"
				? (event.data as Record<string, unknown>)
				: null;
		if (
			event.source !== this.browser ||
			event.origin !== this.browser.location.origin ||
			message?.channel !== "i2nclip-extension-v1" ||
			(message.type !== "probe" && message.type !== "file") ||
			typeof message.token !== "string" ||
			message.token.length > 80 ||
			!message.token
		) {
			return;
		}
		const operation = this.log.operation();
		this.log.debug("received", { operation, type: message.type });
		let result: {
			ok: boolean;
			needsUnlock?: boolean;
			error?: string;
		};
		try {
			const error =
				this.captureRejection() ||
				(this.pending
					? "Unlock i2nclip to finish the pending upload first."
					: "");
			if (error) {
				throw new Error(error);
			}
			if (message.type === "file") {
				const file = message.file;
				if (!(file instanceof File)) {
					throw new Error("Invalid file handoff.");
				}
				contentShape(file.size);
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
				if (get(this.session).unlocked) {
					this.uploadCapture(capture);
				} else {
					this.pending = capture;
					this.log.debug("pending-unlock", { operation });
				}
			}
			result = { ok: true, needsUnlock: !get(this.session).unlocked };
		} catch (error) {
			this.log.warn("rejected", {
				operation,
				type: message.type,
				...failureFields(error),
			});
			result = { ok: false, error: errorMessage(error) };
		}
		this.log.debug("reply-sent", {
			operation,
			ok: result.ok,
			needsUnlock: result.needsUnlock,
		});
		this.browser.postMessage(
			{
				channel: "i2nclip-extension-v1",
				type: "reply",
				token: message.token,
				result,
			},
			this.browser.location.origin,
		);
	}

	private disposeReceiver() {
		if (this.disposed) {
			return;
		}
		this.log.debug("disposed");
		this.disposed = true;
		this.browser.removeEventListener("message", this.receive);
		this.unsubscribeSession();
		this.lifetime?.removeEventListener("abort", this.discard);
		this.discardCapture();
	}

	private syncCaptureSession(value: CaptureSessionState) {
		if (value.signal !== this.lifetime) {
			this.lifetime?.removeEventListener("abort", this.discard);
			this.lifetime = value.signal;
			this.lifetime.addEventListener("abort", this.discard, { once: true });
		}
		if (value.unlocked && !value.configured) {
			this.discardCapture();
		}
		if (this.pending && value.unlocked && !this.captureRejection()) {
			this.log.debug("pending-resumed", { operation: this.pending.operation });
			this.uploadCapture(this.pending);
		}
	}

	private captureUploaded(capture: Capture, signal: AbortSignal, ok: boolean) {
		if (!this.disposed) {
			this.completeCapture(capture, ok, signal.aborted);
		}
	}
}
