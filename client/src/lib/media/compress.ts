// Convert before encryption. A failed or unhelpful conversion keeps the original.
export async function compressImage(file: File, signal: AbortSignal) {
	signal.throwIfAborted();
	if (!/^image\/(jpeg|png|bmp|x-ms-bmp)$/.test(file.type)) {
		return file;
	}
	let bitmap: ImageBitmap | undefined;
	try {
		bitmap = await createImageBitmap(file);
		signal.throwIfAborted();
		const canvas =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(bitmap.width, bitmap.height)
				: document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context =
			"convertToBlob" in canvas
				? canvas.getContext("2d")
				: canvas.getContext("2d");
		if (!context) {
			throw new Error("Canvas context unavailable.");
		}
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
	} catch {
		signal.throwIfAborted();
	} finally {
		bitmap?.close();
	}
	return file;
}
