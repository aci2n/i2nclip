import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createSessionStorage } from "../src/lib/storage/session.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { deferred } from "./helpers.ts";
import { memoryStorage } from "./memory-database.ts";

test("initial storage loads are explicit, shared and never repeated after completion", async (t) => {
	const storage = memoryStorage();
	const sessionDb = storage.connect();
	const preferencesDb = storage.connect();
	const sessionRead = deferred<undefined>();
	const preferencesRead = deferred<boolean>();
	t.after(() => {
		sessionRead.resolve(undefined);
		preferencesRead.resolve(false);
	});
	const reads: string[] = [];
	t.mock.method(sessionDb, "read", async () => {
		reads.push("session");
		return sessionRead.promise;
	});
	t.mock.method(preferencesDb, "read", async () => {
		reads.push("preferences");
		return preferencesRead.promise;
	});
	const session = createSession({
		persistence: createSessionStorage(sessionDb),
	});
	const preferences = createPreferences(preferencesDb);
	t.after(session.dispose);
	t.after(preferences.dispose);
	assert.deepEqual(reads, []);
	const { load: loadSession } = session;
	const { load: loadPreferences } = preferences;
	const loadingSession = loadSession();
	const loadingPreferences = loadPreferences();
	assert.equal(loadSession(), loadingSession);
	assert.equal(loadPreferences(), loadingPreferences);
	assert.deepEqual(reads, ["session", "preferences"]);
	sessionRead.resolve(undefined);
	preferencesRead.resolve(false);
	assert.equal(await loadingSession, true);
	await loadingPreferences;
	assert.equal(get(session).checking, false);
	assert.equal(get(preferences).compressImages, false);
	assert.equal(loadSession(), loadingSession);
	assert.equal(loadPreferences(), loadingPreferences);
	assert.deepEqual(reads, ["session", "preferences"]);
});

test("disposed session and preferences cannot begin initial reads", async (t) => {
	const db = memoryStorage().connect();
	const read = t.mock.method(db, "read", async () => undefined);
	const session = createSession({ persistence: createSessionStorage(db) });
	const preferences = createPreferences(db);
	t.after(session.dispose);
	t.after(preferences.dispose);
	session.dispose();
	preferences.dispose();
	assert.equal(await session.load(), false);
	await preferences.load();
	assert.equal(read.mock.callCount(), 0);
});
