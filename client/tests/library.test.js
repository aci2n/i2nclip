import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createLibrary } from "../src/lib/stores/library.js";
import { deferred, tick } from "./helpers.js";
import { engineClient, serviceFixture, until } from "./service-helpers.js";

test("all clients see per-file progress and only fully successful batches expire", async (t) => {
	const transfer = deferred();
	let attempt = 0;
	const f = await serviceFixture(t, {
		completedRetentionMs: 35,
		upload: async ({ source, onProgress }) => {
			if (source.name === "first.txt") {
				onProgress(37);
				await transfer.promise;
			}
			if (source.name === "second.txt" && ++attempt === 1) {
				throw new Error("offline");
			}
			return { id: source.name };
		},
	});
	const second = engineClient(f.engine);
	t.after(second.dispose);
	await second.ready;
	const a = createLibrary(f.client, {});
	const b = createLibrary(second, {});
	t.after(a.dispose);
	t.after(b.dispose);
	await a.upload([
		new File(["bytes"], "first.txt"),
		new File(["bytes"], "second.txt"),
	]);
	await until(() => get(b).uploadJobs[0]?.progress === 37);
	assert.equal(get(b).uploadJobs[1].status, "queued");
	transfer.resolve();
	await until(() => get(b).uploadFailures.length === 1);
	await new Promise((resolve) => setTimeout(resolve, 65));
	assert.equal(get(b).uploadCompleted.length, 1);
	await b.retryUploads();
	await until(() => get(b).uploadCompleted.length === 2);
	await until(
		() => get(a).uploadJobs.length === 0 && get(b).uploadJobs.length === 0,
	);
	assert.equal((await f.repository.jobs()).length, 0);
	assert.equal(get(a).items.length, 2);
});

test("uploads append matching cards without list refresh and survive older search results", async (t) => {
	const { tagTokens } = await import("../src/lib/protocol/crypto.js");
	const stale = deferred();
	let lists = 0;
	const f = await serviceFixture(t, {
		api: {
			list: async ({ tags, after }) => {
				lists++;
				return tags === "ONE"
					? stale.promise
					: {
							items: after ? [{ id: "old2" }] : [{ id: "old" }],
							next: after ? null : "cursor",
						};
			},
		},
		upload: async ({ credentials }) => ({
			id: "new",
			metadata: { name: "new.txt", tags: ["One"] },
			tokens: await tagTokens(credentials.privateKey, ["One"]),
			metaHash: "hash",
		}),
	});
	const a = createLibrary(f.client, {});
	t.after(a.dispose);
	await until(() => get(a).cards.length === 1);
	const card = get(a).cards[0].media;
	const second = engineClient(f.engine);
	t.after(second.dispose);
	await second.ready;
	const b = createLibrary(second, {}, { query: "ONE" });
	t.after(b.dispose);
	await until(() => get(b).loading);
	const before = lists;
	await a.upload([new File(["bytes"], "new.txt")]);
	await until(() => get(a).cards.length === 2 && get(b).cards.length === 1);
	assert.equal(lists, before);
	assert.equal(get(a).cards[0].media, card);
	assert.deepEqual(
		get(a).items.map((item) => item.id),
		["old", "new"],
	);
	assert.equal(get(a).next, "cursor");
	stale.resolve({ items: [], next: null });
	await until(() => !get(b).loading);
	assert.deepEqual(
		get(b).items.map((item) => item.id),
		["new"],
	);
	await a.more();
	assert.deepEqual(
		get(a).items.map((item) => item.id),
		["old", "new", "old2"],
	);
});

test("deletion preserves cards in all views without refreshing until an explicit search", async (t) => {
	let lists = 0;
	let deleted = false;
	const f = await serviceFixture(t, {
		api: {
			list: async () => {
				lists++;
				return { items: deleted ? [] : [{ id: "file" }], next: null };
			},
			remove: async () => {
				deleted = true;
			},
		},
	});
	const second = engineClient(f.engine);
	t.after(second.dispose);
	await second.ready;
	const a = createLibrary(f.client, { confirm: () => true });
	const b = createLibrary(second, {});
	t.after(a.dispose);
	t.after(b.dispose);
	await until(() => get(a).cards.length && get(b).cards.length);
	const cardA = get(a).cards[0].media;
	const cardB = get(b).cards[0].media;
	const before = lists;
	await a.remove("file");
	assert.equal(lists, before);
	assert.equal(get(a).cards[0].media, cardA);
	assert.equal(get(b).cards[0].media, cardB);
	assert.equal(get(cardA).deleted, true);
	assert.equal(get(cardB).deleted, true);
	await a.search("");
	assert.equal(get(a).cards.length, 0);
	assert.equal(get(b).cards.length, 1);
});

test("library projections preserve independent searches and receive shared media changes", async (t) => {
	const f = await serviceFixture(t, {
		api: {
			list: async ({ tags }) => ({
				items: [{ id: tags || "all" }],
				next: null,
			}),
		},
	});
	const second = engineClient(f.engine);
	t.after(second.dispose);
	await second.ready;
	const a = createLibrary(f.client, {});
	const b = createLibrary(second, {});
	t.after(a.dispose);
	t.after(b.dispose);
	await until(() => get(a).items.length && get(b).items.length);
	await a.search("one");
	await b.search("two");
	assert.deepEqual(
		get(a).items.map((item) => item.id),
		["one"],
	);
	assert.deepEqual(
		get(b).items.map((item) => item.id),
		["two"],
	);
	assert.equal(get(a).query, "one");
	assert.equal(get(b).query, "two");
	await second.command("identity.reset");
	assert.deepEqual(get(a).items, []);
	assert.deepEqual(get(b).items, []);
});

test("replacing results disposes media and prevents a late save dialog", async (t) => {
	const download = deferred();
	let saves = 0;
	const f = await serviceFixture(t, {
		api: {
			list: async ({ tags }) => ({
				items: tags ? [] : [{ id: "file" }],
				next: null,
			}),
			getContent: () => download.promise,
		},
	});
	const library = createLibrary(f.client, {
		download: () => {
			saves++;
		},
	});
	t.after(library.dispose);
	await until(() => get(library).cards.length === 1);
	const downloading = get(library).cards[0].media.download();
	await tick();
	await library.search("absent");
	download.resolve(new Uint8Array([1]));
	await downloading;
	assert.equal(saves, 0);
});

test("an obsolete image reveal cannot open a preview after closing it", async (t) => {
	const job = deferred();
	const f = await serviceFixture(t, {
		api: { list: async () => ({ items: [{ id: "image" }], next: null }) },
	});
	const library = createLibrary(f.client, {});
	t.after(library.dispose);
	await until(() => get(library).cards.length === 1);
	t.mock.method(get(library).cards[0].media, "reveal", () => job.promise);
	const revealing = library.reveal("image");
	library.closePreview();
	job.resolve("blob:late");
	await revealing;
	assert.equal(get(library).selected, null);
});

test("all tabs see failed uploads and can retry retained sources", async (t) => {
	let uploads = 0;
	const f = await serviceFixture(t, {
		upload: async () => {
			if (++uploads === 1) {
				throw new Error("offline");
			}
			return { id: "saved" };
		},
	});
	const second = engineClient(f.engine);
	t.after(second.dispose);
	await second.ready;
	const a = createLibrary(f.client, {});
	const b = createLibrary(second, {});
	t.after(a.dispose);
	t.after(b.dispose);
	const file = new File(["bytes"], "one.txt");
	await a.upload([file]);
	await until(() => get(b).uploadFailures.length === 1);
	assert.equal(get(b).uploadFailures[0].file.name, "one.txt");
	await b.retryUploads();
	await until(() => !get(b).uploading && !get(b).uploadFailures.length);
	assert.equal(uploads, 2);
});

test("metadata refresh preserves the rendered card and its inline editor resource owner", async (t) => {
	const { tagTokens } = await import("../src/lib/protocol/crypto.js");
	let item = {
		id: "file",
		metadata: { name: "file.txt", tags: [], content_type: "text/plain" },
		tokens: [],
		metaHash: "a",
	};
	const refresh = deferred();
	let lists = 0;
	const f = await serviceFixture(t, {
		api: {
			list: async () =>
				++lists === 1 ? { items: [item], next: null } : refresh.promise,
			updateMetadata: async ({ metadata, privateKey }) => {
				item = {
					...item,
					metadata,
					tokens: await tagTokens(privateKey, metadata.tags),
					metaHash: "b",
				};
				return { tokens: item.tokens, metaHash: "b", conflict: false };
			},
		},
	});
	const library = createLibrary(f.client, {});
	t.after(library.dispose);
	await until(() => get(library).cards.length === 1);
	const card = get(library).cards[0].media;
	assert.equal(await library.retag("file", ["New"]), true);
	assert.equal(get(library).cards[0].media, card);
	assert.deepEqual(get(card).metadata.tags, ["New"]);
	refresh.resolve({ items: [item], next: null });
	await until(() => !get(library).loading);
	assert.equal(get(library).cards[0].media, card);
});
