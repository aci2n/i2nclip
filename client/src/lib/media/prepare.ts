import {
	checkFileSize,
	DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
	MAX_FILE_PLAINTEXT_BYTES,
} from "../api.ts";
import { canCompressImage, compressImage } from "./image.ts";

export function checkSourceSize(
	file: File,
	compressImages: boolean,
	maxFilePlaintextBytes = DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
) {
	const limit = Math.min(maxFilePlaintextBytes, MAX_FILE_PLAINTEXT_BYTES);
	if (!compressImages || !canCompressImage(file) || limit === 0) {
		checkFileSize(file.size, limit);
	}
}

interface PreparationRequest {
	file: File;
	compressImages: boolean;
	signal: AbortSignal;
	maxFilePlaintextBytes?: number;
	onNotice?: (message: string) => void;
}

export async function prepareFile({
	file,
	compressImages,
	signal,
	maxFilePlaintextBytes = DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
	onNotice,
}: PreparationRequest) {
	signal.throwIfAborted();
	checkSourceSize(file, compressImages, maxFilePlaintextBytes);
	if (compressImages) {
		file = await compressImage(file, signal, onNotice);
	}
	signal.throwIfAborted();
	checkFileSize(
		file.size,
		Math.min(maxFilePlaintextBytes, MAX_FILE_PLAINTEXT_BYTES),
	);
	return file;
}
