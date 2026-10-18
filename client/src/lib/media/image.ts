export function canCompressImage(file: Pick<File, "type">) {
	return /^image\/(jpeg|png|bmp|x-ms-bmp)$/.test(file.type);
}

// Convert before encryption. A failed or unhelpful conversion keeps the original.
export async function compressImage(
	file: File,
	signal: AbortSignal,
	onNotice?: (message: string) => void,
) {
	signal.throwIfAborted();
	if (!canCompressImage(file)) {
		return file;
	}
	let bitmap: ImageBitmap | undefined;
	try {
		bitmap = await createImageBitmap(file);
		signal.throwIfAborted();
		const context =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")
				: document.createElement("canvas").getContext("2d");
		if (!context) {
			throw new Error("Canvas context unavailable.");
		}
		const { canvas } = context;
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		context.drawImage(bitmap, 0, 0);
		const blob =
			"convertToBlob" in canvas
				? await canvas.convertToBlob({ type: "image/webp", quality: 0.85 })
				: await new Promise<Blob | null>((resolve) =>
						canvas.toBlob(resolve, "image/webp", 0.85),
					);
		signal.throwIfAborted();
		if (blob?.type === "image/webp" && blob.size < file.size) {
			const name = file.name.replace(/\.[^.]*$/, "") || file.name;
			return new File([blob], `${name}.webp`, { type: blob.type });
		}
		onNotice?.(
			"Using original: WebP encoding is unsupported or was not smaller.",
		);
	} catch {
		signal.throwIfAborted();
		onNotice?.("Using original: image compression failed.");
	} finally {
		bitmap?.close();
	}
	return file;
}
