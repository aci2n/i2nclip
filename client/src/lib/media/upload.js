import { MAX_FILE_BYTES, upload } from "../api.js";
import { compressImage } from "./compress.js";
import { thumbnail } from "./thumbnail.js";

export function checkFileSize(size) {
	if (size > MAX_FILE_BYTES) {
		throw new Error("File is larger than 32 MB.");
	}
}
export async function sendUpload({
	file,
	credentials,
	compressImages = true,
	tags = "",
	extra = {},
	onProgress,
	signal,
}) {
	checkFileSize(file.size);
	signal.throwIfAborted();
	if (compressImages) {
		file = await compressImage(file, signal);
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	signal.throwIfAborted();
	const preview = await thumbnail(file, bytes, signal);
	signal.throwIfAborted();
	return upload({
		...credentials,
		bytes,
		name: file.name,
		contentType: file.type || "application/octet-stream",
		tags,
		image: preview?.image,
		extra,
		thumb: preview?.thumb,
		onProgress,
		signal,
	});
}
