import { createContentStreams } from "../../src/lib/stores/content-streams.ts";

const clip = new URL("../fixtures/clip.webm", import.meta.url).href;

const controller = new AbortController();
const streams = createContentStreams(controller.signal);
const sources = new Map<string, Awaited<ReturnType<typeof streams.open>>>();
const metrics = {
	reads: [] as { start: number; end: number }[],
	active: 0,
	maximumActive: 0,
	maximumRead: 0,
	aborted: 0,
};
let sequence = 0;

function pause(milliseconds: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			abort();
		}
	});
}

const proof = {
	metrics,
	async generated(size: number, delay = 0, type = "application/octet-stream") {
		const header = new Uint8Array(44);
		if (type === "audio/wav") {
			const view = new DataView(header.buffer);
			const text = (offset: number, value: string) =>
				header.set(new TextEncoder().encode(value), offset);
			text(0, "RIFF");
			view.setUint32(4, size - 8, true);
			text(8, "WAVEfmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, 8000, true);
			view.setUint32(28, 16000, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			text(36, "data");
			view.setUint32(40, size - 44, true);
		}
		const session = await streams.open({
			size,
			name: "Generated file.bin",
			type,
			async read(start, end, signal) {
				metrics.active++;
				metrics.maximumActive = Math.max(metrics.maximumActive, metrics.active);
				metrics.maximumRead = Math.max(metrics.maximumRead, end - start);
				metrics.reads.push({ start, end });
				try {
					if (delay) {
						await pause(delay, signal);
					}
					signal.throwIfAborted();
					const result = new Uint8Array(end - start);
					for (let index = 0; index < result.length; index++) {
						result[index] =
							type === "audio/wav" && start + index < 44
								? header[start + index]
								: (start + index) % 251;
					}
					return result;
				} catch (error) {
					metrics.aborted++;
					throw error;
				} finally {
					metrics.active--;
				}
			},
		});
		const key = String(sequence++);
		sources.set(key, session);
		return { key, url: session.url, downloadUrl: session.downloadUrl };
	},
	async audio(size: number) {
		const source = await proof.generated(size, 10, "audio/wav");
		const audio = document.createElement("audio");
		audio.controls = true;
		audio.preload = "metadata";
		audio.src = source.url;
		document.body.append(audio);
		return source.url;
	},
	async video() {
		const blob = await (await fetch(clip)).blob();
		const session = await streams.open({
			size: blob.size,
			name: "Clip.webm",
			type: "video/webm",
			async read(start, end, signal) {
				metrics.reads.push({ start, end });
				signal.throwIfAborted();
				return new Uint8Array(await blob.slice(start, end).arrayBuffer());
			},
		});
		const video = document.createElement("video");
		video.controls = true;
		video.muted = true;
		video.src = session.url;
		document.body.append(video);
		return session.url;
	},
	dispose(key: string) {
		sources.get(key)?.dispose();
		sources.delete(key);
	},
	lock() {
		controller.abort();
	},
};

declare global {
	interface Window {
		streamingProof: typeof proof;
	}
}
window.streamingProof = proof;
