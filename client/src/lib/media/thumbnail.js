// A small WebP for the library card, encrypted with the metadata in one
// MessagePack document, so the list can paint a card without
// downloading the original. Audio uses embedded cover art when the file has
// some. A failure here just means the card has no preview.

import { audioArt } from "./audio-art.js";

const EDGE = 320;

export async function thumbnail(blob, bytes, signal) {
	const type = blob.type || "";
	try {
		if (type.startsWith("audio/")) {
			const art = audioArt(bytes);
			if (!art) {
				return null;
			}
			return await fromBitmap(new Blob([art]), signal);
		}
		if (type.startsWith("video/")) {
			return await fromVideo(blob, signal);
		}
		return await fromBitmap(blob, signal);
	} catch {
		return null;
	}
}

async function fromBitmap(blob, signal) {
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

async function webp(source) {
	const width = source.videoWidth || source.width;
	const height = source.videoHeight || source.height;
	if (!width || !height) {
		return null;
	}
	const scale = Math.min(1, EDGE / Math.max(width, height));
	const targetWidth = Math.max(1, Math.round(width * scale));
	const targetHeight = Math.max(1, Math.round(height * scale));
	const canvas =
		typeof OffscreenCanvas !== "undefined"
			? new OffscreenCanvas(targetWidth, targetHeight)
			: document.createElement("canvas");
	canvas.width = targetWidth;
	canvas.height = targetHeight;
	canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
	const file = canvas.convertToBlob
		? await canvas.convertToBlob({ type: "image/webp", quality: 0.75 })
		: await new Promise((resolve) =>
				canvas.toBlob(resolve, "image/webp", 0.75),
			);
	return file ? new Uint8Array(await file.arrayBuffer()) : null;
}

function fromVideo(blob, signal) {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(blob);
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		let settled = false;
		const finish = (value) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
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
		video.addEventListener("error", () => finish(null));
		video.addEventListener("loadeddata", async () => {
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
		});
		video.src = url;
	});
}
