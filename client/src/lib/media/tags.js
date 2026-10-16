import { uniqueTags } from "../protocol/tags.js";
import { isText } from "./text.js";

const FORMATS = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/x-ms-bmp": "bmp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
	"image/tiff": "tiff",
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/ogg": "ogg",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"application/pdf": "pdf",
	"application/json": "json",
};

export function automaticTags(name, contentType) {
	const type = contentType.toLowerCase().split(";")[0].trim();
	const category =
		/^(image|audio|video)\//.exec(type)?.[1] ||
		(isText(type, name) ? "text" : "file");
	const extension = /[^.]\.([\p{L}\p{N}]+)$/u.exec(name)?.[1] || "";
	const normalizedExtension = extension.toLowerCase();
	const format =
		FORMATS[type] ||
		(normalizedExtension === "jpeg" ? "jpg" : normalizedExtension);
	const stem = extension ? name.slice(0, -(extension.length + 1)) : name;
	const words =
		stem
			.normalize("NFC")
			.toLowerCase()
			.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || [];
	return uniqueTags(
		[category, format || "", ...words].filter((tag) => [...tag].length <= 64),
	).slice(0, 40);
}
