// The browser often leaves blob.type empty for a right-clicked image.
// A few leading bytes are enough to pick a type the library page can render.
// File contents are not parsed beyond that.

export function sniffContentType(bytes, fallback) {
	const given = String(fallback || "")
		.toLowerCase()
		.split(";")[0]
		.trim();
	if (given && given !== "application/octet-stream") return given;
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	)
		return "image/jpeg";
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	)
		return "image/png";
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46
	)
		return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46
	) {
		const kind = new TextDecoder().decode(bytes.subarray(8, 12));
		if (kind === "WEBP") return "image/webp";
		if (kind === "WAVE") return "audio/wav";
	}
	if (
		bytes.length >= 12 &&
		bytes[4] === 0x66 &&
		bytes[5] === 0x74 &&
		bytes[6] === 0x79 &&
		bytes[7] === 0x70
	) {
		return "video/mp4";
	}
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x1a &&
		bytes[1] === 0x45 &&
		bytes[2] === 0xdf &&
		bytes[3] === 0xa3
	) {
		return "video/webm";
	}
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x4f &&
		bytes[1] === 0x67 &&
		bytes[2] === 0x67 &&
		bytes[3] === 0x53
	) {
		return "audio/ogg";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0x49 &&
		bytes[1] === 0x44 &&
		bytes[2] === 0x33
	)
		return "audio/mpeg";
	return given || "application/octet-stream";
}
