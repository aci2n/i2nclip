import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import * as api from "../src/lib/api.ts";
import { createPersistence } from "../src/lib/persistence.ts";
import { createLibrary } from "../src/lib/stores/library.ts";
import { createMediaViewer } from "../src/lib/stores/media-viewer.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { createTags } from "../src/lib/stores/tags.ts";
import { deferred, mediaData, testKey } from "./helpers.ts";
import { memoryStorage } from "./memory-database.ts";

test("library, tags and viewer leave initial requests to their owner", async (t) => {
	const lifetime = new AbortController();
	t.after(() => lifetime.abort());
	const context = {
		serverUrl: "https://clip.example",
		key: testKey(),
		signal: lifetime.signal,
	};
	const calls: string[] = [];
	const library = createLibrary(context, {
		http: {
			...api,
			list: async () => {
				calls.push("library");
				return { items: [], next: null };
			},
		},
	});
	t.after(library.dispose);
	const tags = createTags(context, {
		http: {
			getTags: async () => {
				calls.push("tags");
				return { tags: ["image"], invalid: 0 };
			},
		},
	});
	t.after(tags.dispose);
	const viewer = createMediaViewer("a".repeat(64), context, {
		http: {
			getMedia: async () => {
				calls.push("viewer");
				return mediaData({
					id: "a".repeat(64),
					metadata: { name: "file", content_type: "application/octet-stream" },
				});
			},
			readContentRange: async () => {
				throw new Error("Unexpected content read");
			},
		},
	});
	t.after(viewer.dispose);
	assert.deepEqual(calls, []);
	const { search } = library;
	const { refresh } = tags;
	const { retry } = viewer;
	assert.deepEqual(await Promise.all([search(), refresh(), retry()]), [
		true,
		true,
		true,
	]);
	assert.deepEqual(calls, ["library", "tags", "viewer"]);
	assert.equal(get(library).empty, "library");
	assert.deepEqual(get(tags).tags, ["image"]);
	assert.equal(get(viewer).media?.metadata?.name, "file");
});

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
	const session = createSession({ persistence: createPersistence(sessionDb) });
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

test("disposed stores cannot begin their initial reads", async (t) => {
	const db = memoryStorage().connect();
	const read = t.mock.method(db, "read", async () => undefined);
	const session = createSession({ persistence: createPersistence(db) });
	const preferences = createPreferences(memoryStorage().connect());
	const library = createLibrary(
		{
			serverUrl: "https://clip.example",
			key: testKey(),
			signal: new AbortController().signal,
		},
		{
			http: {
				...api,
				list: async () => {
					throw new Error("Unexpected list request");
				},
			},
		},
	);
	t.after(session.dispose);
	t.after(preferences.dispose);
	t.after(library.dispose);
	session.dispose();
	preferences.dispose();
	library.dispose();
	assert.equal(await session.load(), false);
	await preferences.load();
	assert.equal(await library.search(), false);
	assert.equal(read.mock.callCount(), 0);
});
