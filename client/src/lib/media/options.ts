export type ImageFormat = "webp" | "jpeg" | "png";

export interface ImageOptions {
	enabled: boolean;
	format: ImageFormat;
	quality: number;
	maxWidth: number | null;
	maxHeight: number | null;
}

// Each media type owns its encoding parameters; batch handling is format independent.
export interface UploadOptions {
	image: ImageOptions;
}

export function defaultUploadOptions(): UploadOptions {
	return {
		image: {
			enabled: true,
			format: "webp",
			quality: 85,
			maxWidth: null,
			maxHeight: null,
		},
	};
}

export function copyUploadOptions(options: UploadOptions): UploadOptions {
	return { image: { ...options.image } };
}

export function validUploadOptions(value: unknown): value is UploadOptions {
	if (!value || typeof value !== "object" || !("image" in value)) {
		return false;
	}
	const image = value.image;
	if (!image || typeof image !== "object") {
		return false;
	}
	const v = image as ImageOptions;
	const dimension = (n: unknown) =>
		n === null || (typeof n === "number" && Number.isSafeInteger(n) && n > 0);
	return (
		typeof v.enabled === "boolean" &&
		["webp", "jpeg", "png"].includes(v.format) &&
		typeof v.quality === "number" &&
		Number.isFinite(v.quality) &&
		v.quality >= 0 &&
		v.quality <= 100 &&
		dimension(v.maxWidth) &&
		dimension(v.maxHeight)
	);
}

export function canConvertImage(file: Pick<File, "type">) {
	return /^image\/(jpeg|png|bmp|x-ms-bmp)$/.test(file.type);
}
