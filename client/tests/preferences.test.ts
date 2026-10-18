import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { bytesToB64 } from "../src/lib/protocol/bytes.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";

test("compression defaults on and persists independently of identity", () => {
	const values = new Map([["i2nclip.identity", "untouched"]]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const preferences = createPreferences(storage);
	assert.equal(get(preferences).compressImages, true);
	preferences.setCompression(false);
	assert.equal(get(createPreferences(storage)).compressImages, false);
	assert.equal(values.get("i2nclip.identity"), "untouched");
	preferences.setCompression(true);
	assert.equal(get(createPreferences(storage)).compressImages, true);
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
	assert.equal(get(preferences).compressImages, true);
	assert.ok(get(preferences).error);
	preferences.setCompression(false);
	assert.equal(get(preferences).compressImages, true);
	assert.match(get(preferences).error, /save/);
});

for (const saved of [
	"corrupt",
	bytesToB64(encode("false")),
	bytesToB64(encode({ enabled: false })),
]) {
	test(`invalid compression preference uses the default and reports feedback: ${saved}`, () => {
		const preferences = createPreferences({
			getItem: () => saved,
			setItem() {},
		});
		assert.equal(get(preferences).compressImages, true);
		assert.match(get(preferences).error, /read/);
	});
}
