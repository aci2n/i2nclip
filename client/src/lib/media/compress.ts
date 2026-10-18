import {
	canConvertImage,
	defaultUploadOptions,
	type ImageOptions,
} from "./options.ts";

// Convert before encryption. A failed or unhelpful conversion keeps the original.
export async function compressImage(
	file: File,
	signal: AbortSignal,
	options: ImageOptions = defaultUploadOptions().image,
	onNotice?: (message: string) => void,
) {
	signal.throwIfAborted();
	if (!options.enabled || !canConvertImage(file)) {
		return file;
	}
	let bitmap: ImageBitmap | undefined;
	try {
		bitmap = await createImageBitmap(file);
		signal.throwIfAborted();
		const scale = Math.min(
			1,
			(options.maxWidth ?? bitmap.width) / bitmap.width,
			(options.maxHeight ?? bitmap.height) / bitmap.height,
		);
		const width = Math.max(1, Math.floor(bitmap.width * scale));
		const height = Math.max(1, Math.floor(bitmap.height * scale));
		const type = `image/${options.format}`;
		const quality =
			options.format === "png" ? undefined : options.quality / 100;
		const context =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(width, height).getContext("2d")
				: document.createElement("canvas").getContext("2d");
		if (!context) {
			throw new Error("Canvas context unavailable.");
		}
		const { canvas } = context;
		canvas.width = width;
		canvas.height = height;
		if (options.format === "jpeg") {
			context.fillStyle = "#fff";
			context.fillRect(0, 0, width, height);
		}
		context.drawImage(bitmap, 0, 0, width, height);
		const blob =
			"convertToBlob" in canvas
				? await canvas.convertToBlob({ type, quality })
				: await new Promise<Blob | null>((resolve) =>
						canvas.toBlob(resolve, type, quality),
					);
		signal.throwIfAborted();
		if (blob?.type === type && blob.size < file.size) {
			const name = file.name.replace(/\.[^.]*$/, "") || file.name;
			return new File(
				[blob],
				`${name}.${options.format === "jpeg" ? "jpg" : options.format}`,
				{ type: blob.type },
			);
		}
		onNotice?.(
			blob?.type === type
				? "Using original: converted file was not smaller."
				: "Using original: requested image encoding is unsupported.",
		);
	} catch {
		signal.throwIfAborted();
		onNotice?.("Using original: image conversion failed.");
	} finally {
		bitmap?.close();
	}
	return file;
}
