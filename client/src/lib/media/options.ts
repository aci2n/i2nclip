export type ImageFormat = "webp" | "jpeg" | "png";

export interface ImageOptions {
	enabled: boolean;
	format: ImageFormat;
	quality: number;
	maxWidth: number | null;
	maxHeight: number | null;
}

export const videoCodecs = {
	mp4: ["avc", "hevc", "av1"],
	webm: ["vp8", "vp9", "av1"],
} as const;
export const videoQualities = [
	"very-low",
	"low",
	"medium",
	"high",
	"very-high",
] as const;
export type VideoFormat = keyof typeof videoCodecs;
export type VideoCodec = (typeof videoCodecs)[VideoFormat][number];
export interface VideoOptions {
	enabled: boolean;
	format: VideoFormat;
	codec: VideoCodec;
	quality: (typeof videoQualities)[number];
	maxWidth: number | null;
	maxHeight: number | null;
	maxFrameRate: number | null;
}

// Each media type owns its encoding parameters; batch handling is format independent.
export interface UploadOptions {
	image: ImageOptions;
	video: VideoOptions;
}

export function defaultUploadOptions(): UploadOptions {
	return {
		video: {
			enabled: false,
			format: "mp4",
			codec: "avc",
			quality: "medium",
			maxWidth: null,
			maxHeight: null,
			maxFrameRate: null,
		},
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
	return { image: { ...options.image }, video: { ...options.video } };
}

export function validUploadOptions(value: unknown): value is UploadOptions {
	if (
		!value ||
		typeof value !== "object" ||
		!("image" in value) ||
		!("video" in value)
	) {
		return false;
	}
	const image = value.image;
	if (!image || typeof image !== "object") {
		return false;
	}
	const video = value.video;
	if (!video || typeof video !== "object") {
		return false;
	}
	const imageOptions = image as ImageOptions;
	const videoOptions = video as VideoOptions;
	const dimension = (n: unknown) =>
		n === null || (typeof n === "number" && Number.isSafeInteger(n) && n > 0);
	return (
		typeof imageOptions.enabled === "boolean" &&
		["webp", "jpeg", "png"].includes(imageOptions.format) &&
		typeof imageOptions.quality === "number" &&
		Number.isFinite(imageOptions.quality) &&
		imageOptions.quality >= 0 &&
		imageOptions.quality <= 100 &&
		dimension(imageOptions.maxWidth) &&
		dimension(imageOptions.maxHeight) &&
		typeof videoOptions.enabled === "boolean" &&
		(videoOptions.format === "mp4" || videoOptions.format === "webm") &&
		(videoCodecs[videoOptions.format] as readonly string[]).includes(
			videoOptions.codec,
		) &&
		videoQualities.includes(videoOptions.quality) &&
		dimension(videoOptions.maxWidth) &&
		dimension(videoOptions.maxHeight) &&
		(videoOptions.maxFrameRate === null ||
			(typeof videoOptions.maxFrameRate === "number" &&
				Number.isFinite(videoOptions.maxFrameRate) &&
				videoOptions.maxFrameRate > 0))
	);
}

export function canConvertImage(file: Pick<File, "type">) {
	return /^image\/(jpeg|png|bmp|x-ms-bmp)$/.test(file.type);
}

export function canConvertVideo(file: Pick<File, "type" | "name">) {
	return (
		file.type.startsWith("video/") ||
		((!file.type || file.type === "application/octet-stream") &&
			/\.(mp4|m4v|mov|webm|mkv|ts|mts|m2ts|ogv)$/i.test(file.name))
	);
}
