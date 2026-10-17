import assert from "node:assert/strict";
import test from "node:test";
import { canPreview } from "../src/lib/media/format.ts";
import {
	decodeTextPreview,
	isText,
	TEXT_PREVIEW_BYTES,
} from "../src/lib/media/text.ts";

test("text detection recognizes MIME types and code filenames while keeping native media viewers", () => {
	for (const [type, name] of [
		["text/plain; charset=utf-8", "file"],
		["application/json", "file"],
		["application/problem+json", "file"],
		["application/xml", "file"],
		["application/octet-stream", "SOURCE.RS"],
		["", "config.yaml"],
		["text/html", "index.html"],
	]) {
		assert.equal(isText(type, name), true);
		assert.equal(canPreview(type, name), true);
	}
	for (const [type, name] of [
		["image/svg+xml", "image.svg"],
		["image/png", "image.txt"],
		["audio/wav", "audio.txt"],
		["video/webm", "video.txt"],
		["application/pdf", "document.pdf"],
		["", "file.txt.exe"],
	]) {
		assert.equal(isText(type, name), false);
	}
	assert.equal(canPreview("image/svg+xml", "image.svg"), true);
	assert.equal(canPreview("application/pdf", "document.pdf"), false);
});

test("UTF-8 text decoding is bounded and does not emit a partial trailing character", () => {
	const bytes = new TextEncoder().encode(
		`${"a".repeat(TEXT_PREVIEW_BYTES - 1)}éafter`,
	);
	const preview = decodeTextPreview(bytes);
	assert.equal(preview, "a".repeat(TEXT_PREVIEW_BYTES - 1));
	assert.equal(decodeTextPreview(new Uint8Array()), "");
	assert.equal(
		decodeTextPreview(new TextEncoder().encode("<script>markup</script>")),
		"<script>markup</script>",
	);
	assert.equal(decodeTextPreview(new Uint8Array([0xff])), "�");
});
