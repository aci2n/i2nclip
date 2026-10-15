export const TEXT_PREVIEW_BYTES = 256 * 1024;

const EXTENSIONS =
	/\.(txt|md|csv|tsv|log|json|jsonl|xml|yaml|yml|toml|ini|conf|js|jsx|ts|tsx|css|html|svg|sh|py|rs|sql)$/i;

export function isText(type = "", name = "") {
	const mime = type.toLowerCase().split(";")[0].trim();
	if (/^(image|audio|video)\//.test(mime)) {
		return false;
	}
	return (
		mime.startsWith("text/") ||
		/^application\/(?:json|xml|[\w.+-]+\+(?:json|xml))$/.test(mime) ||
		EXTENSIONS.test(name)
	);
}

export function decodeTextPreview(
	bytes,
	truncated = bytes.length > TEXT_PREVIEW_BYTES,
) {
	return new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_BYTES), {
		stream: truncated,
	});
}
