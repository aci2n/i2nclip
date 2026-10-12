import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createLibrary } from "../src/lib/stores/library.js";
import { deferred, tick } from "./helpers.js";
import { engineClient, serviceFixture, until } from "./service-helpers.js";

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
	const a = createLibrary(f.client, {}),
		b = createLibrary(second, {});
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
			if (++uploads === 1) throw new Error("offline");
			return { id: "saved" };
		},
	});
	const second = engineClient(f.engine);
	t.after(second.dispose);
	await second.ready;
	const a = createLibrary(f.client, {}),
		b = createLibrary(second, {});
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
