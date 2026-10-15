import { MAX_FILE_BYTES, upload } from "../api.js";
import { thumbnail } from "./thumbnail.js";

export function checkFileSize(size) {
	if (size > MAX_FILE_BYTES) {
		throw new Error("File is larger than 32 MB.");
	}
}
export async function sendUpload({
	file,
	credentials,
	tags = "",
	extra = {},
	onProgress,
	signal,
}) {
	checkFileSize(file.size);
	signal.throwIfAborted();
	const bytes = new Uint8Array(await file.arrayBuffer());
	signal.throwIfAborted();
	const preview = await thumbnail(file, signal);
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
