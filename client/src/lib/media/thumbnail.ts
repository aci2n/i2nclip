import { audioArt } from "./audio-art.ts";
import { PREPARATION_BYTES } from "./prepare.ts";

interface Preview {
	thumb: Uint8Array<ArrayBuffer>;
	image: { width: number; height: number };
}

// A small WebP for the library card, encrypted with the metadata in one
// MessagePack document, so the list can paint a card without
// downloading the original. Audio uses embedded cover art when the file has
// some. A failure here just means the card has no preview.

const EDGE = 320;

export async function thumbnail(blob: Blob, signal?: AbortSignal) {
	const type = blob.type || "";
	try {
		signal?.throwIfAborted();
		if (type.startsWith("video/")) {
			return await fromVideo(blob, signal);
		}
		if (blob.size > PREPARATION_BYTES) {
			return null;
		}
		if (type.startsWith("audio/")) {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			signal?.throwIfAborted();
			const art = audioArt(bytes);
			if (!art) {
				return null;
			}
			return await fromBitmap(new Blob([art]), signal);
		}
		return await fromBitmap(blob, signal);
	} catch {
		return null;
	}
}

async function fromBitmap(blob: Blob, signal?: AbortSignal) {
	const bitmap = await createImageBitmap(blob);
	try {
		signal?.throwIfAborted();
		const thumb = await webp(bitmap);
		if (!thumb) {
			return null;
		}
		return { thumb, image: { width: bitmap.width, height: bitmap.height } };
	} finally {
		bitmap.close();
	}
}

async function webp(source: ImageBitmap | HTMLVideoElement) {
	const width = "videoWidth" in source ? source.videoWidth : source.width;
	const height = "videoHeight" in source ? source.videoHeight : source.height;
	if (!width || !height) {
		return null;
	}
	const scale = Math.min(1, EDGE / Math.max(width, height));
	const targetWidth = Math.max(1, Math.round(width * scale));
	const targetHeight = Math.max(1, Math.round(height * scale));
	const context =
		typeof OffscreenCanvas !== "undefined"
			? new OffscreenCanvas(targetWidth, targetHeight).getContext("2d")
			: document.createElement("canvas").getContext("2d");
	if (!context) {
		throw new Error("Canvas context unavailable.");
	}
	const { canvas } = context;
	canvas.width = targetWidth;
	canvas.height = targetHeight;
	context.drawImage(source, 0, 0, canvas.width, canvas.height);
	const file =
		"convertToBlob" in canvas
			? await canvas.convertToBlob({ type: "image/webp", quality: 0.75 })
			: await new Promise<Blob | null>((resolve) =>
					canvas.toBlob(resolve, "image/webp", 0.75),
				);
	return file ? new Uint8Array(await file.arrayBuffer()) : null;
}

function fromVideo(blob: Blob, signal?: AbortSignal) {
	return new Promise<Preview | null>((resolve) => {
		const url = URL.createObjectURL(blob);
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		let settled = false;
		const finish = (value: Preview | null) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			video.removeEventListener("error", failed);
			video.removeEventListener("loadeddata", loaded);
			signal?.removeEventListener("abort", abort);
			URL.revokeObjectURL(url);
			video.removeAttribute("src");
			video.load();
			resolve(value);
		};
		const abort = () => finish(null);
		const timer = setTimeout(() => finish(null), 8000);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			finish(null);
			return;
		}
		function failed() {
			finish(null);
		}
		async function loaded() {
			if (settled) {
				return;
			}
			try {
				const thumb = await webp(video);
				finish(
					thumb
						? {
								thumb,
								image: { width: video.videoWidth, height: video.videoHeight },
							}
						: null,
				);
			} catch {
				finish(null);
			}
		}
		video.addEventListener("error", failed);
		video.addEventListener("loadeddata", loaded, { once: true });
		video.src = url;
	});
}
