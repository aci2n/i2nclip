import type { Credentials, Progress } from "../api.ts";
import { MAX_FILE_BYTES, upload } from "../api.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { compressImage } from "./compress.ts";
import { thumbnail } from "./thumbnail.ts";
export interface SendOptions {
	file: File;
	credentials: Credentials;
	compressImages?: boolean;
	tags?: string;
	extra?: Metadata;
	onProgress?: Progress;
	signal: AbortSignal;
}

export function checkFileSize(size: number) {
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
}: SendOptions) {
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
