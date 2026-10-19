import { contentShape } from "../protocol/content.ts";
import { compressImage } from "./image.ts";

// Image/audio preparation is bounded; native video thumbnails use the File.
export const PREPARATION_BYTES = 32 * 1024 * 1024;

interface PreparationRequest {
	file: File;
	compressImages: boolean;
	signal: AbortSignal;
	onNotice?: (message: string) => void;
}

export async function prepareFile({
	file,
	compressImages,
	signal,
	onNotice,
}: PreparationRequest) {
	signal.throwIfAborted();
	contentShape(file.size);
	if (file.size > PREPARATION_BYTES) {
		if (!file.type.startsWith("video/")) {
			onNotice?.(
				"Uploading original file; image compression and image/audio thumbnail preparation are skipped above 32 MiB.",
			);
		}
		return file;
	}
	if (compressImages) {
		file = await compressImage(file, signal, onNotice);
	}
	signal.throwIfAborted();
	return file;
}
