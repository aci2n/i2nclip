// Convert before encryption. A failed or unhelpful conversion keeps the original.
export async function compressImage(file, signal) {
	signal.throwIfAborted();
	if (!/^image\/(jpeg|png)$/.test(file.type)) {
		return file;
	}
	let bitmap;
	try {
		bitmap = await createImageBitmap(file);
		signal.throwIfAborted();
		const canvas =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(bitmap.width, bitmap.height)
				: document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext("2d").drawImage(bitmap, 0, 0);
		const blob = canvas.convertToBlob
			? await canvas.convertToBlob({ type: "image/webp", quality: 0.85 })
			: await new Promise((resolve) =>
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
