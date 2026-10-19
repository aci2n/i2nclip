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

interface ExtensionReceiverDependencies {
	session: CaptureSession;
	getUploads: () => CaptureUploads | null;
	onupload: () => void;
	browser: ReceiverBrowser;
	log: ReturnType<typeof createLog>;
}
interface ExtensionReceiverRuntime {
	pending: Capture | null;
	disposed: boolean;
	lifetime: AbortSignal | null;
	discard: () => void;
	receive: (event: CaptureEvent) => void;
}

// Each app tab owns its receiver and at most one pending capture.
export function createExtensionReceiver(
	session: CaptureSession,
	getUploads: () => CaptureUploads | null,
	onupload: () => void,
	browser: ReceiverBrowser = window,
) {
	const deps: ExtensionReceiverDependencies = {
		session,
		getUploads,
		onupload,
		browser,
		log: createLog("extension-receiver"),
	};
	deps.log.debug("created");
	const runtime: ExtensionReceiverRuntime = {
		pending: null,
		disposed: false,
		lifetime: null,
		discard: () => discardCapture(deps, runtime),
		receive: (event) => receiveCapture(deps, runtime, event),
	};
	const unsubscribeSession = session.subscribe((value) =>
		syncCaptureSession(deps, runtime, value),
	);
	browser.addEventListener("message", runtime.receive);

	return {
		dispose: () => disposeReceiver(deps, runtime, unsubscribeSession),
	};
}

function captureRejection(deps: ExtensionReceiverDependencies) {
	const value = get(deps.session);
	const uploads = deps.getUploads();
	if (value.status === "new" || (value.unlocked && !value.configured)) {
		return "Set up your uploads in i2nclip, then retry.";
	}
	if (value.busy || (uploads ? get(uploads).uploading : false)) {
		return "i2nclip is busy. Wait for the current operation, then retry.";
	}
	return "";
}

function completeCapture(
	deps: ExtensionReceiverDependencies,
	capture: Capture,
	ok: boolean,
	cancelled = false,
) {
	deps.log.debug("completed", { operation: capture.operation, ok, cancelled });
	deps.browser.postMessage(
		{
			channel: "i2nclip-extension-v1",
			type: "complete",
			token: capture.token,
			result: cancelled ? { ok: false, cancelled: true } : { ok },
		},
		deps.browser.location.origin,
	);
}

function discardCapture(
	deps: ExtensionReceiverDependencies,
	runtime: ExtensionReceiverRuntime,
) {
	const capture = runtime.pending;
	runtime.pending = null;
	if (capture) {
		deps.log.debug("pending-discarded", { operation: capture.operation });
		completeCapture(deps, capture, false, true);
	}
}

function uploadCapture(
	deps: ExtensionReceiverDependencies,
	runtime: ExtensionReceiverRuntime,
	capture: Capture,
) {
	deps.log.info("upload-started", { operation: capture.operation });
	runtime.pending = null;
	const signal = get(deps.session).signal;
	deps.onupload();
	const uploads = deps.getUploads();
	if (!uploads) {
		completeCapture(deps, capture, false, true);
		return;
	}
	void uploads
		.upload([capture.file], capture.extra)
		.then((ok) => captureUploaded(deps, runtime, capture, signal, ok));
}

function receiveCapture(
	deps: ExtensionReceiverDependencies,
	runtime: ExtensionReceiverRuntime,
	event: CaptureEvent,
) {
	const message =
		event.data && typeof event.data === "object"
			? (event.data as Record<string, unknown>)
			: null;
	if (
		event.source !== deps.browser ||
		event.origin !== deps.browser.location.origin ||
		message?.channel !== "i2nclip-extension-v1" ||
		(message.type !== "probe" && message.type !== "file") ||
		typeof message.token !== "string" ||
		message.token.length > 80 ||
		!message.token
	) {
		return;
	}
	const operation = deps.log.operation();
	deps.log.debug("received", { operation, type: message.type });
	let result: {
		ok: boolean;
		needsUnlock?: boolean;
		error?: string;
	};
	try {
		const error =
			captureRejection(deps) ||
			(runtime.pending
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
					...(sourceUrl === undefined ? {} : { source_url: string(sourceUrl) }),
					...(sourceTitle === undefined
						? {}
						: { source_title: string(sourceTitle) }),
				},
				token: message.token,
			};
			if (get(deps.session).unlocked) {
				uploadCapture(deps, runtime, capture);
			} else {
				runtime.pending = capture;
				deps.log.debug("pending-unlock", { operation });
			}
		}
		result = { ok: true, needsUnlock: !get(deps.session).unlocked };
	} catch (error) {
		deps.log.warn("rejected", {
			operation,
			type: message.type,
			...failureFields(error),
		});
		result = { ok: false, error: errorMessage(error) };
	}
	deps.log.debug("reply-sent", {
		operation,
		ok: result.ok,
		needsUnlock: result.needsUnlock,
	});
	deps.browser.postMessage(
		{
			channel: "i2nclip-extension-v1",
			type: "reply",
			token: message.token,
			result,
		},
		deps.browser.location.origin,
	);
}

function disposeReceiver(
	deps: ExtensionReceiverDependencies,
	runtime: ExtensionReceiverRuntime,
	unsubscribeSession: () => void,
) {
	deps.log.debug("disposed");
	runtime.disposed = true;
	deps.browser.removeEventListener("message", runtime.receive);
	unsubscribeSession();
	runtime.lifetime?.removeEventListener("abort", runtime.discard);
	discardCapture(deps, runtime);
}

function syncCaptureSession(
	deps: ExtensionReceiverDependencies,
	runtime: ExtensionReceiverRuntime,
	value: CaptureSessionState,
) {
	if (value.signal !== runtime.lifetime) {
		runtime.lifetime?.removeEventListener("abort", runtime.discard);
		runtime.lifetime = value.signal;
		runtime.lifetime.addEventListener("abort", runtime.discard, { once: true });
	}
	if (value.unlocked && !value.configured) {
		discardCapture(deps, runtime);
	}
	if (runtime.pending && value.unlocked && !captureRejection(deps)) {
		deps.log.debug("pending-resumed", { operation: runtime.pending.operation });
		uploadCapture(deps, runtime, runtime.pending);
	}
}
function captureUploaded(
	deps: ExtensionReceiverDependencies,
	runtime: ExtensionReceiverRuntime,
	capture: Capture,
	signal: AbortSignal,
	ok: boolean,
) {
	if (!runtime.disposed) {
		completeCapture(deps, capture, ok, signal.aborted);
	}
}
