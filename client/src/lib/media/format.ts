import { isText } from "./text.ts";
export const MEDIA_EXTENSIONS: Readonly<Record<string, string | undefined>> = {
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
	const units = ["MB", "GB", "TB", "PB", "EB"];
	let size = bytes / (1024 * 1024);
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}
	return `${size.toFixed(1)} ${units[unit]}`;
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

const FILE_TYPES: Readonly<Record<string, string | undefined>> = {
	"image/jpeg": "JPEG",
	"audio/mpeg": "MP3",
	"application/octet-stream": "FILE",
};

export function fileType(type: string) {
	return (
		FILE_TYPES[type] ||
		(type.split("/")[1]?.split(/[;+]/)[0] || "FILE").toUpperCase()
	);
}
