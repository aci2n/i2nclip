import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadName } from "../src/lib/media/format.js";
import { automaticTags } from "../src/lib/media/tags.js";

test("automatic tags follow stored format and tokenize Unicode filenames", () => {
	assert.deepEqual(
		automaticTags("Summer_holiday—Córdoba 2026.jpg", "image/webp"),
		["image", "webp", "summer", "holiday", "córdoba", "2026"],
	);
	assert.deepEqual(automaticTags("Notes.JPEG", "application/octet-stream"), [
		"file",
		"jpg",
		"notes",
	]);
	assert.deepEqual(automaticTags("Résumé notes.md", ""), [
		"text",
		"md",
		"résumé",
		"notes",
	]);
	assert.deepEqual(automaticTags("Audio audio.mp3", "audio/mpeg"), [
		"audio",
		"mp3",
	]);
	assert.deepEqual(automaticTags("no-extension", "video/mp4"), [
		"video",
		"mp4",
		"no",
		"extension",
	]);
});

test("automatic tags deduplicate before the cap and skip overlong words", () => {
	const tags = automaticTags(
		`file file ${"a".repeat(65)} ${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}`,
		"",
	);
	assert.equal(tags.length, 40);
	assert.deepEqual(tags.slice(0, 3), ["file", "word0", "word1"]);
	assert.equal(tags.at(-1), "word38");
	assert.deepEqual(automaticTags("Cafe\u0301 café.txt", "text/plain"), [
		"text",
		"txt",
		"café",
	]);
});

test("extension case folding does not truncate Unicode filenames", () => {
	assert.deepEqual(automaticTags("Photo.İ", ""), ["file", "i\u0307", "photo"]);
	assert.deepEqual(automaticTags("Summer.JPEG", "image/jpeg"), [
		"image",
		"jpg",
		"summer",
	]);
});

test("tag formats share download extensions while retaining caller-specific fallbacks", () => {
	for (const [type, extension] of [
		["image/jpeg", "jpg"],
		["audio/mpeg", "mp3"],
		["video/webm", "webm"],
	]) {
		assert.equal(downloadName("Clip", type), `Clip.${extension}`);
		assert.equal(automaticTags("Clip", type)[1], extension);
		assert.equal(downloadName("Clip.original", type), "Clip.original");
	}
	assert.equal(downloadName("Document", "application/pdf"), "Document");
	assert.deepEqual(automaticTags("Document", "application/pdf"), [
		"file",
		"pdf",
		"document",
	]);
	assert.equal(
		downloadName("Notes.JPEG", "application/octet-stream"),
		"Notes.JPEG",
	);
	assert.deepEqual(automaticTags("Notes.JPEG", "application/octet-stream"), [
		"file",
		"jpg",
		"notes",
	]);
});
