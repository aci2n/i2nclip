import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { defaultUploadOptions } from "../src/lib/media/options.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";

test("compression defaults on and persists independently of identity", () => {
	const values = new Map([["i2nclip.identity", "untouched"]]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const preferences = createPreferences(storage);
	assert.equal(get(preferences).options.image.enabled, true);
	preferences.setOptions({
		...defaultUploadOptions(),
		image: { ...defaultUploadOptions().image, enabled: false },
	});
	assert.equal(get(createPreferences(storage)).options.image.enabled, false);
	assert.equal(values.get("i2nclip.identity"), "untouched");
	preferences.setOptions(defaultUploadOptions());
	assert.equal(get(createPreferences(storage)).options.image.enabled, true);
});

test("storage failures retain the preference and report feedback", () => {
	const preferences = createPreferences({
		getItem() {
			throw new Error();
		},
		setItem() {
			throw new Error();
		},
	});
	assert.equal(get(preferences).options.image.enabled, true);
	assert.ok(get(preferences).error);
	preferences.setOptions({
		...defaultUploadOptions(),
		image: { ...defaultUploadOptions().image, enabled: false },
	});
	assert.equal(get(preferences).options.image.enabled, true);
	assert.match(get(preferences).error, /save/);
});

test("all image parameters persist as a snapshot and old checkbox is ignored", () => {
	const values = new Map([["i2nclip.compress-images", "invalid old value"]]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	const preferences = createPreferences(storage);
	assert.equal(get(preferences).error, "");
	const options = {
		...defaultUploadOptions(),
		image: {
			...defaultUploadOptions().image,
			format: "jpeg" as const,
			maxWidth: 800,
			maxHeight: 600,
			quality: 71,
		},
	};
	preferences.setOptions(options);
	options.image.quality = 0;
	assert.equal(get(preferences).options.image.quality, 71);
	assert.deepEqual(
		get(createPreferences(storage)).options,
		get(preferences).options,
	);
});

test("invalid defaults are rejected and invalid stored records report feedback", () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	const preferences = createPreferences(storage);
	for (const patch of [
		{ quality: NaN },
		{ quality: -1 },
		{ quality: 101 },
		{ maxWidth: 0 },
		{ maxHeight: 1.5 },
		{ format: "bad" },
	]) {
		preferences.setOptions({
			...defaultUploadOptions(),
			image: { ...defaultUploadOptions().image, ...patch },
		} as Parameters<typeof preferences.setOptions>[0]);
		assert.deepEqual(get(preferences).options, defaultUploadOptions());
		assert.ok(get(preferences).error);
	}
	values.set("i2nclip.media-upload-options", "broken");
	const loaded = get(createPreferences(storage));
	assert.deepEqual(loaded.options, defaultUploadOptions());
	assert.ok(loaded.error);
});

test("video defaults reset previous records and persist independent codec parameters", () => {
	const values = new Map([
		["i2nclip.upload-options", "previous preferences are ignored"],
	]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	const preferences = createPreferences(storage);
	assert.deepEqual(get(preferences).options.video, {
		enabled: false,
		format: "mp4",
		codec: "avc",
		quality: "medium",
		maxWidth: null,
		maxHeight: null,
		maxFrameRate: null,
	});
	assert.equal(get(preferences).error, "");
	const options = defaultUploadOptions();
	options.video = {
		enabled: true,
		format: "webm",
		codec: "av1",
		quality: "very-low",
		maxWidth: 800,
		maxHeight: 600,
		maxFrameRate: 29.97,
	};
	preferences.setOptions(options);
	const saved = get(createPreferences(storage)).options;
	assert.deepEqual(saved, options);
	options.video.maxWidth = 1;
	assert.equal(get(preferences).options.video.maxWidth, 800);
	assert.equal(get(preferences).options.image.quality, 85);
	for (const patch of [
		{ format: "bogus" },
		{ codec: "hevc" },
		{ quality: "bogus" },
		{ maxWidth: 1.5 },
		{ maxHeight: 0 },
		{ maxFrameRate: 0 },
		{ maxFrameRate: Infinity },
		{ maxFrameRate: NaN },
	]) {
		preferences.setOptions({
			...saved,
			video: { ...saved.video, ...patch },
		} as typeof saved);
		assert.deepEqual(get(preferences).options, saved);
		assert.ok(get(preferences).error);
	}
});
