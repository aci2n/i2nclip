import type { Credentials, Progress } from "../api.ts";
import { upload } from "../api.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { prepareFile } from "./prepare.ts";
import { thumbnail } from "./thumbnail.ts";
export interface SendOptions {
	file: File;
	maxFilePlaintextBytes?: number;
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
	maxFilePlaintextBytes,
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
		maxFilePlaintextBytes,
		onNotice,
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
