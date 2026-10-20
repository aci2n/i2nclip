import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createPreferences } from "../src/lib/stores/preferences.ts";
import { deferred } from "./helpers.ts";
import { memoryStorage } from "./memory-database.ts";

test("compression defaults on and persists independently of identity", async (t) => {
	const storage = memoryStorage();
	storage.values.set("session", "untouched");
	const preferences = createPreferences(storage.connect());
	t.after(preferences.dispose);
	await preferences.loaded;
	assert.equal(get(preferences).compressImages, true);
	await preferences.setCompression(false);
	const restored = createPreferences(storage.connect());
	t.after(restored.dispose);
	await restored.loaded;
	assert.equal(get(restored).compressImages, false);
	assert.equal(storage.values.get("session"), "untouched");
	await preferences.setCompression(true);
	assert.equal(storage.values.get("compressImages"), true);
});

test("storage failures retain the preference and report feedback", async (t) => {
	const db = memoryStorage().connect();
	t.mock.method(db, "read", async () => {
		throw new Error("Read failed");
	});
	t.mock.method(db, "update", async () => {
		throw new Error("Write failed");
	});
	const preferences = createPreferences(db);
	t.after(preferences.dispose);
	await preferences.loaded;
	assert.equal(get(preferences).compressImages, true);
	assert.match(get(preferences).error, /read/);
	await preferences.setCompression(false);
	assert.equal(get(preferences).compressImages, true);
	assert.match(get(preferences).error, /save/);
});

for (const saved of ["corrupt", null, { enabled: false }]) {
	test(`invalid preference uses the default and reports feedback: ${JSON.stringify(saved)}`, async (t) => {
		const storage = memoryStorage();
		storage.values.set("compressImages", saved);
		const preferences = createPreferences(storage.connect());
		t.after(preferences.dispose);
		await preferences.loaded;
		assert.equal(get(preferences).compressImages, true);
		assert.match(get(preferences).error, /read/);
	});
}

test("save waits for startup, rejects overlap, and disposal suppresses late publication", async (t) => {
	const storage = memoryStorage();
	const db = storage.connect();
	const pending = deferred<boolean>();
	t.after(() => pending.resolve(true));
	t.mock.method(db, "read", async () => pending.promise);
	const preferences = createPreferences(db);
	const saving = preferences.setCompression(false);
	await preferences.setCompression(true);
	pending.resolve(true);
	await saving;
	assert.equal(storage.values.get("compressImages"), false);
	const before = get(preferences);
	preferences.dispose();
	await preferences.setCompression(true);
	assert.equal(get(preferences), before);
});

test("disposal during startup ignores the late stored preference", async (t) => {
	const db = memoryStorage().connect();
	const pending = deferred<boolean>();
	t.after(() => pending.resolve(false));
	t.mock.method(db, "read", async () => pending.promise);
	const preferences = createPreferences(db);
	preferences.dispose();
	const before = get(preferences);
	pending.resolve(false);
	await preferences.loaded;
	assert.equal(get(preferences), before);
});
