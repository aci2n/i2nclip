import assert from "node:assert/strict";
import test from "node:test";
import {
	canConvertVideo,
	defaultUploadOptions,
	validUploadOptions,
	videoCodecs,
} from "../src/lib/media/options.ts";

test("video eligibility uses MIME or extension only when MIME is absent/generic", () => {
	for (const name of [
		"movie.MP4",
		"movie.m4v",
		"movie.mov",
		"movie.webm",
		"movie.mkv",
		"movie.ts",
		"movie.mts",
		"movie.m2ts",
		"movie.ogv",
	]) {
		for (const type of ["", "application/octet-stream", "video/custom"]) {
			assert.equal(canConvertVideo({ name, type }), true);
		}
		assert.equal(canConvertVideo({ name, type: "audio/mp4" }), false);
	}
	for (const name of ["document.txt", "playlist.m3u8", "audio.ogg"]) {
		assert.equal(canConvertVideo({ name, type: "" }), false);
	}
});

test("only declared container and codec combinations are valid", () => {
	for (const format of ["mp4", "webm"] as const) {
		for (const codec of ["avc", "hevc", "av1", "vp8", "vp9"] as const) {
			assert.equal(
				validUploadOptions({
					...defaultUploadOptions(),
					video: { ...defaultUploadOptions().video, format, codec },
				}),
				(videoCodecs[format] as readonly string[]).includes(codec),
			);
		}
	}
});
