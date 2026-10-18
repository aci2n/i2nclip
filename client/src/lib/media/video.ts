import type {
	Conversion,
	ConversionVideoOptions,
	InputVideoTrack,
} from "mediabunny";
import * as mediabunny from "mediabunny";
import type { Progress } from "../api.ts";
import type { VideoOptions } from "./options.ts";

// Read displayed dimensions so rotation and non-square pixels are respected.
async function trackOptions(
	track: InputVideoTrack,
	options: VideoOptions,
): Promise<ConversionVideoOptions> {
	const [width, height] = await Promise.all([
		track.getDisplayWidth(),
		track.getDisplayHeight(),
	]);
	const scale = Math.min(
		1,
		(options.maxWidth ?? width) / width,
		(options.maxHeight ?? height) / height,
	);
	const targetWidth = Math.floor((width * scale) / 2) * 2;
	const targetHeight = Math.floor((height * scale) / 2) * 2;
	if (targetWidth < 2 || targetHeight < 2) {
		throw new Error("Video dimensions are too small to encode.");
	}
	let frameRate: number | undefined;
	if (options.maxFrameRate !== null) {
		const { averagePacketRate } = await track.computePacketStats();
		if (!Number.isFinite(averagePacketRate) || averagePacketRate <= 0) {
			throw new Error("Unable to measure video frame rate.");
		}
		if (options.maxFrameRate < averagePacketRate) {
			frameRate = options.maxFrameRate;
		}
	}
	return {
		width: targetWidth,
		height: targetHeight,
		fit: "contain",
		frameRate,
		codec: options.codec,
		forceTranscode: true,
		allowTransformationMetadata: false,
	};
}

// The caller owns the signal. All codec/container probing stays inside this workflow.
export async function convertVideo(
	file: File,
	signal: AbortSignal,
	options: VideoOptions,
	onNotice?: (message: string) => void,
	onProgress?: Progress,
	bunny: typeof mediabunny = mediabunny,
) {
	signal.throwIfAborted();
	if (!options.enabled) {
		return file;
	}
	let reason = "video conversion failed or is unsupported.";
	try {
		onProgress?.(0);
		signal.throwIfAborted();
		const input = new bunny.Input({
			source: new bunny.BlobSource(file),
			formats: [
				bunny.MP4,
				bunny.QTFF,
				bunny.MATROSKA,
				bunny.WEBM,
				bunny.OGG,
				bunny.MPEG_TS,
			],
		});
		const target = new bunny.BufferTarget();
		const format =
			options.format === "mp4"
				? new bunny.Mp4OutputFormat({ fastStart: false })
				: new bunny.WebMOutputFormat();
		const output = new bunny.Output({ format, target });
		let conversion: Conversion | undefined;
		let stopping: Promise<void> | undefined;
		let tooLarge = false;
		let active = true;
		async function cancel() {
			if (
				conversion &&
				conversion.state !== "done" &&
				conversion.state !== "canceled"
			) {
				await conversion.cancel();
			} else if (output.state !== "finalized" && output.state !== "canceled") {
				await output.cancel();
			}
		}
		const stop = () => {
			input.dispose();
			stopping ??= cancel().catch(() => {});
		};
		const stopWrites = target.on("write", ({ end }) => {
			if (end >= file.size && !tooLarge) {
				tooLarge = true;
				reason = "converted video was not smaller.";
				stop();
			}
		});
		signal.addEventListener("abort", stop, { once: true });
		try {
			signal.throwIfAborted();
			if (!(await input.getVideoTracks()).length) {
				reason = "no video track was found.";
				throw new Error(reason);
			}
			conversion = await bunny.Conversion.init({
				input,
				output,
				tracks: "all",
				showWarnings: false,
				video: async (track) => ({
					...(await trackOptions(track, options)),
					quality: new bunny.Quality(options.quality),
				}),
			});
			signal.throwIfAborted();
			if (!conversion.isValid || conversion.discardedTracks.length) {
				reason = "requested conversion cannot retain every track.";
				throw new Error(reason);
			}
			conversion.onProgress = (progress) => {
				if (active && !tooLarge && !signal.aborted) {
					onProgress?.(Math.min(99, Math.round(progress * 100)));
				}
			};
			await conversion.execute();
			signal.throwIfAborted();
			const buffer = target.buffer;
			if (
				!tooLarge &&
				output.state === "finalized" &&
				buffer &&
				buffer.byteLength > 0 &&
				buffer.byteLength < file.size
			) {
				onProgress?.(100);
				const name = file.name.replace(/\.[^.]*$/, "") || file.name;
				return new File([buffer], `${name}${format.fileExtension}`, {
					type: format.mimeType,
				});
			}
			if (!tooLarge) {
				reason = "converted video was empty, incomplete, or not smaller.";
			}
		} finally {
			active = false;
			if (conversion) {
				conversion.onProgress = undefined;
			}
			signal.removeEventListener("abort", stop);
			stopWrites();
			input.dispose();
			await stopping;
			await cancel();
			signal.throwIfAborted();
		}
	} catch {
		signal.throwIfAborted();
	}
	onNotice?.(`Using original: ${reason}`);
	return file;
}
