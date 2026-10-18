import {
	checkFileSize,
	DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
	MAX_FILE_PLAINTEXT_BYTES,
	type Progress,
} from "../api.ts";
import { compressImage } from "./image.ts";
import {
	canConvertImage,
	canConvertVideo,
	type UploadOptions,
} from "./options.ts";
import { convertVideo } from "./video.ts";

// Source size is checked before decoding, but eligible media gets an encoding attempt.
export function checkSourceSize(
	file: File,
	options: UploadOptions,
	maxFilePlaintextBytes = DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
) {
	const sourceSize = file.size;
	const limit = Math.min(maxFilePlaintextBytes, MAX_FILE_PLAINTEXT_BYTES);
	const convertible =
		(options.image.enabled && canConvertImage(file)) ||
		(options.video.enabled && canConvertVideo(file));
	if (!convertible || limit === 0) {
		checkFileSize(sourceSize, limit);
	}
}

interface ConversionRequest {
	file: File;
	options: UploadOptions;
	signal: AbortSignal;
	maxFilePlaintextBytes?: number;
	onNotice?: (message: string) => void;
	onProgress?: Progress;
}

export async function convertMedia({
	file,
	options,
	signal,
	maxFilePlaintextBytes = DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
	onNotice,
	onProgress,
}: ConversionRequest) {
	signal.throwIfAborted();
	checkSourceSize(file, options, maxFilePlaintextBytes);
	if (canConvertImage(file)) {
		file = await compressImage(file, signal, options.image, onNotice);
	} else if (canConvertVideo(file)) {
		file = await convertVideo(
			file,
			signal,
			options.video,
			onNotice,
			onProgress,
		);
	}
	signal.throwIfAborted();
	checkFileSize(
		file.size,
		Math.min(maxFilePlaintextBytes, MAX_FILE_PLAINTEXT_BYTES),
	);
	return file;
}
