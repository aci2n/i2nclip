import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { bytesToHex, hexToBytes } from "../src/lib/protocol/bytes.ts";
import { createRecord } from "../src/lib/protocol/chain.ts";
import {
	type ChainState,
	encodeOperation,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import {
	type FileMetadata,
	newFileContent,
} from "../src/lib/protocol/file-objects.ts";
import type { Files } from "../src/lib/services/files.ts";
import { createSessionStorage } from "../src/lib/storage/session.ts";
import type { ChainStore, ChainView } from "../src/lib/stores/chain.ts";
import type { ContentStreams } from "../src/lib/stores/content-streams.ts";
import { createLibrary } from "../src/lib/stores/library.ts";
import { createMaterializedView } from "../src/lib/stores/materialized-view.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { deferred } from "./helpers.ts";
import { initialSessionState, registerSession } from "./library-fixture.ts";
import { memoryStorage } from "./memory-database.ts";

const filled = (n: number) => new Uint8Array(32).fill(n);
async function fixture(t: test.TestContext) {
	const session = createSession({
		persistence: createSessionStorage(memoryStorage().connect()),
		download: () => {},
		http: { registered: async () => false, register: async () => {} },
		verify: async (_identity, head) => head,
	});
	t.after(session.dispose);
	await session.load();
	await session.initialize("local password");
	await registerSession(session, {
		serverUrl: "https://example.test",
		otc: "invite",
	});
	const context = get(session).context;
	assert.ok(context);
	let state = await initialSessionState(session);
	const history = new Map<number, ChainState>([[state.sequence, state]]);
	const source = writable<ChainView>({
		live: state,
		syncing: false,
		error: "",
		storageError: "",
	});
	const id = filled(1);
	let stages = 0;
	let commits = 0;
	let commitWait: Promise<void> = Promise.resolve();
	const chain: ChainStore = {
		subscribe: source.subscribe,
		sync: async () => state,
		at: async (sequence) => {
			const selected = history.get(sequence);
			assert.ok(selected);
			return selected;
		},
		append: async (change) => {
			change.signal?.throwIfAborted();
			change.check?.(state);
			const record = await createRecord(
				{
					library: state.library,
					sequence: state.sequence + 1,
					previous: state.head,
					effects: change.effects,
				},
				context.key,
				context.encryption,
				change.plaintext,
			);
			state = reduceBlock(state, record, change.plaintext);
			history.set(state.sequence, state);
			source.update((value) => ({ ...value, live: state }));
			return state;
		},
		dispose() {},
	};
	await chain.append({
		effects: [["publish", id, filled(9)]],
		plaintext: encodeOperation({
			kind: "AddFile",
			id,
			manifest: { hash: filled(2), key: filled(3) },
			metadata: { hash: filled(4), key: filled(5) },
		}),
	});
	const metadata = new Map<number, FileMetadata>([
		[
			4,
			{
				attributes: {
					name: "original.txt",
					content_type: "text/plain",
					tags: ["Original"],
				},
				thumbnail: null,
			},
		],
	]);
	const content = await newFileContent(5);
	content.rawKey.fill(0);
	const files: Files = {
		upload: async () => {
			throw new Error("Unused");
		},
		metadata: async (file) => {
			const value = metadata.get(file.metadata.hash[0]);
			assert.ok(value);
			return value;
		},
		manifest: async () => ({ content: content.content, hashes: [filled(6)] }),
		thumbnail: async () => null,
		readRange: async () => new TextEncoder().encode("hello"),
		prepareEdit: async (file, patch, _thumb, signal) => {
			signal.throwIfAborted();
			stages++;
			const hash = filled(20 + stages);
			const previous = metadata.get(file.metadata.hash[0]);
			assert.ok(previous);
			metadata.set(hash[0], {
				...previous,
				attributes: { ...previous.attributes, ...patch },
			});
			return {
				operation: {
					kind: "ReplaceMetadata",
					id: file.id,
					metadata: { hash, key: filled(30) },
				},
				effects: [["commit", file.id, [hash]]],
			};
		},
		commit: async (change, signal) => {
			signal.throwIfAborted();
			commits++;
			await commitWait;
			signal.throwIfAborted();
			return chain.append({
				check: change.check,
				effects: change.effects,
				plaintext: encodeOperation(change.operation),
				signal,
			});
		},
		dispose() {},
	};
	const view = createMaterializedView(chain, files, context.signal);
	t.after(view.dispose);
	const downloading = deferred();
	const downloadStarted = deferred<AbortSignal>();
	let saved = 0;
	const invalidated: string[] = [];
	const streams: ContentStreams = {
		open: async () => ({
			url: "stream:inline",
			downloadUrl: "stream:download",
			dispose() {},
		}),
		download: async (_source, start, lifetime) => {
			assert.ok(lifetime);
			downloadStarted.resolve(lifetime);
			await start("stream:download");
			const abort = () => downloading.reject(new Error("Purged"));
			lifetime.addEventListener("abort", abort, { once: true });
			try {
				await downloading.promise;
			} finally {
				lifetime.removeEventListener("abort", abort);
			}
		},
		invalidate: (id) => {
			invalidated.push(id);
		},
		dispose() {},
	};
	const library = createLibrary(
		session,
		chain,
		view,
		files,
		streams,
		context.signal,
		{
			confirm: () => true,
			save: () => {
				saved++;
			},
		},
	);
	t.after(library.dispose);
	await library.browse();
	return {
		library,
		view,
		id: bytesToHex(id),
		history,
		chain,
		context,
		stats: () => ({ stages, commits, saved }),
		waitForCommit: (wait: Promise<void>) => {
			commitWait = wait;
		},
		downloadStarted,
		downloading,
		invalidated,
		current: () => state,
	};
}

test("metadata changes render only after acceptance and historical views reject all mutations", async (t) => {
	const f = await fixture(t);
	const pending = deferred();
	f.waitForCommit(pending.promise);
	const update = f.library.updateMetadata(
		f.id,
		{ name: "updated.txt" },
		get(f.library).cards[0].revision,
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(get(f.library).cards[0].metadata?.name, "original.txt");
	pending.resolve();
	assert.equal(await update, true);
	await f.view.index();
	assert.equal(get(f.library).cards[0].metadata?.name, "updated.txt");
	assert.equal(await f.view.select(1), true);
	await f.view.index();
	assert.equal(get(f.library).cards[0].metadata?.name, "original.txt");
	assert.equal(get(f.library).readonly, true);
	assert.equal(
		await f.library.updateMetadata(
			f.id,
			{ name: "forbidden" },
			get(f.library).cards[0].revision,
		),
		false,
	);
	assert.equal(await f.library.remove(f.id), false);
	assert.equal(await f.library.restore(f.id), false);
	assert.equal(await f.library.purge(f.id), false);
	assert.equal(f.stats().commits, 1);
	assert.equal(await f.view.select(2), true);
	assert.equal(get(f.library).readonly, true);
});

test("logical deletion, restore, and purge follow the selected materialized state", async (t) => {
	const f = await fixture(t);
	assert.equal(await f.library.remove(f.id), true);
	await f.view.index();
	assert.equal(get(f.library).cards.length, 0);
	f.library.showDeleted(true);
	await f.view.index(true);
	assert.equal(get(f.library).cards[0].metadata?.name, "original.txt");
	assert.equal(await f.library.restore(f.id), true);
	await f.view.index(true);
	assert.equal(get(f.library).cards.length, 0);
	f.library.showDeleted(false);
	await f.view.index();
	assert.equal(get(f.library).cards.length, 1);
	assert.equal(await f.library.remove(f.id), true);
	f.library.showDeleted(true);
	await f.view.index(true);
	assert.equal(await f.library.purge(f.id), true);
	assert.equal(get(f.library).cards.length, 0);
	assert.ok(f.invalidated.includes(f.id));
});

test("root-owned downloads survive preview closure and time travel but abort on purge", async (t) => {
	const f = await fixture(t);
	const result = f.library.download(f.id);
	const signal = await f.downloadStarted.promise;
	f.library.closePreview();
	await f.view.select(1);
	assert.equal(signal.aborted, false);
	assert.equal(f.stats().saved, 1);
	await f.view.select(null);
	assert.equal(await f.library.remove(f.id), true);
	f.library.showDeleted(true);
	await f.view.index(true);
	assert.equal(await f.library.purge(f.id), true);
	assert.equal(signal.aborted, true);
	assert.equal(await result, false);
});

test("an editor's old source revision is rejected before staging and requires explicit retry", async (t) => {
	const f = await fixture(t);
	const original = get(f.library).cards[0].revision;
	assert.equal(
		await f.library.updateMetadata(f.id, { name: "first.txt" }, original),
		true,
	);
	await f.view.index();
	assert.equal(
		await f.library.updateMetadata(f.id, { name: "draft.txt" }, original),
		false,
	);
	assert.equal(f.stats().stages, 1);
	assert.equal(f.stats().commits, 1);
	assert.match(get(f.library).cards[0].message, /Review your draft/);
	assert.equal(
		await f.library.updateMetadata(
			f.id,
			{ name: "draft.txt" },
			get(f.library).cards[0].revision,
		),
		true,
	);
	await f.view.index();
	assert.equal(get(f.library).cards[0].metadata?.name, "draft.txt");
});

test("lifecycle changes reject when another writer already applied them", async (t) => {
	const f = await fixture(t);
	await f.chain.append({
		effects: [],
		plaintext: encodeOperation({ kind: "DeleteFile", id: hexToBytes(f.id) }),
	});
	assert.equal(await f.library.remove(f.id), false);
	f.library.showDeleted(true);
	await f.view.index(true);
	assert.match(get(f.library).cards[0]?.message ?? "", /file changed/);
	assert.equal(f.current().files.get(f.id)?.deleted, true);
});

test("invalid private links fail locally before chain or metadata reads", async (t) => {
	const f = await fixture(t);
	const sync = t.mock.method(f.chain, "sync");
	assert.equal(await f.library.reveal("bad"), false);
	assert.equal(sync.mock.callCount(), 0);
	assert.equal(get(f.library).status, "Invalid media link.");
});
