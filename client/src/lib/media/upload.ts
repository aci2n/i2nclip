import type { Credentials, Progress } from "../api.ts";
import { upload } from "../api.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { PREPARATION_BYTES, prepareFile } from "./prepare.ts";
import { thumbnail } from "./thumbnail.ts";
export interface SendOptions {
	file: File;
	credentials: Credentials;
	compressImages?: boolean;
	onNotice?: (message: string) => void;
	onPrepared?: (name: string) => void;
	tags?: string;
	extra?: Metadata;
	onProgress?: Progress;
	signal: AbortSignal;
}

export async function sendUpload({
	file,
	credentials,
	compressImages = true,
	onNotice,
	onPrepared,
	tags = "",
	extra = {},
	onProgress,
	signal,
}: SendOptions) {
	file = await prepareFile({
		file,
		compressImages,
		signal,
		onNotice,
	});
	signal.throwIfAborted();
	onPrepared?.(file.name);
	signal.throwIfAborted();
	const preview =
		file.size <= PREPARATION_BYTES
			? await thumbnail(file, new Uint8Array(await file.arrayBuffer()), signal)
			: null;
	signal.throwIfAborted();
	onProgress?.(0);
	return upload({
		...credentials,
		file,
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
