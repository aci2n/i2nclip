import { isText } from "./text.ts";
export const MEDIA_EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"audio/mpeg": "mp3",
	"audio/ogg": "ogg",
	"audio/wav": "wav",
};

export function canPreview(type: string, name: string) {
	return /^(image|audio|video)\//.test(type || "") || isText(type, name);
}

export function fileSize(bytes?: number) {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
		return "";
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function uploadedAt(seconds: number) {
	return seconds
		? new Date(seconds * 1000).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: "";
}

export function downloadName(name: string, type: string) {
	const base =
		String(name || "download")
			.split(/[/\\]/)
			.pop() || "download";
	const ext = MEDIA_EXTENSIONS[type];
	return base.includes(".") || !ext ? base : `${base}.${ext}`;
}

export function fileType(type: string) {
	return (
		(
			{
				"image/jpeg": "JPEG",
				"audio/mpeg": "MP3",
				"application/octet-stream": "FILE",
			} as Record<string, string>
		)[type] || (type.split("/")[1]?.split(/[;+]/)[0] || "FILE").toUpperCase()
	);
}
