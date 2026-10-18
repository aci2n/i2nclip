import type { Credentials, Progress } from "../api.ts";
import { upload } from "../api.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { convertMedia } from "./convert.ts";
import { defaultUploadOptions, type UploadOptions } from "./options.ts";
import { thumbnail } from "./thumbnail.ts";
export interface SendOptions {
	file: File;
	maxFilePlaintextBytes?: number;
	credentials: Credentials;
	options?: UploadOptions;
	onNotice?: (message: string) => void;
	onConversionProgress?: Progress;
	onPrepared?: (name: string) => void;
	tags?: string;
	extra?: Metadata;
	onProgress?: Progress;
	signal: AbortSignal;
}

export async function sendUpload({
	file,
	maxFilePlaintextBytes,
	credentials,
	options = defaultUploadOptions(),
	onNotice,
	onConversionProgress,
	onPrepared,
	tags = "",
	extra = {},
	onProgress,
	signal,
}: SendOptions) {
	file = await convertMedia({
		file,
		options,
		signal,
		maxFilePlaintextBytes,
		onNotice,
		onProgress: onConversionProgress,
	});
	onPrepared?.(file.name);
	signal.throwIfAborted();
	const bytes = new Uint8Array(await file.arrayBuffer());
	signal.throwIfAborted();
	const preview = await thumbnail(file, bytes, signal);
	signal.throwIfAborted();
	onProgress?.(0);
	return upload({
		...credentials,
		bytes,
		maxFilePlaintextBytes,
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
