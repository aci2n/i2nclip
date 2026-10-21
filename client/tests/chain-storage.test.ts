import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
	CacheConflict,
	type CachedBlock,
	clearChainCaches,
	createChainStorage,
} from "../src/lib/storage/chain.ts";
import { createDatabase } from "../src/lib/storage/database.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
const hash = (n: number) => n.toString(16).padStart(64, "0");
const genesis = { sequence: 0, hash: hash(0) };
const signal = () => new AbortController().signal;
function block(n: number): CachedBlock {
	return {
		sequence: n,
		hash: hash(n),
		previous: hash(n - 1),
		bytes: new Uint8Array([n]),
	};
}

test("bootstrap preserves the trusted minimum across prefix writes and reopening", async (t) => {
	const factory = new IDBFactory();
	const first = createChainStorage(
		"https://example.test/path",
		genesis.hash,
		factory,
	);
	t.after(first.dispose);
	const pin = { sequence: 3, hash: hash(3) };
	assert.deepEqual(await first.ensureHead(pin, signal()), pin);
	assert.deepEqual(await first.append(pin, genesis, [block(1)], signal()), pin);
	first.dispose();
	const second = createChainStorage(
		"https://example.test",
		genesis.hash,
		factory,
	);
	t.after(second.dispose);
	assert.deepEqual(await second.head(signal()), pin);
	assert.deepEqual(await second.read(0, signal()), [block(1)]);
	await second.append(pin, block(1), [block(2), block(3), block(4)], signal());
	assert.deepEqual(await second.head(signal()), { sequence: 4, hash: hash(4) });
	await second.discardRecords(signal());
	assert.deepEqual(await second.read(0, signal()), []);
	assert.equal((await second.head(signal()))?.sequence, 4);
});

test("concurrent connections compare and swap without overwriting another tab", async (t) => {
	const factory = new IDBFactory();
	const a = createChainStorage("https://example.test", genesis.hash, factory);
	const b = createChainStorage("https://example.test", genesis.hash, factory);
	t.after(a.dispose);
	t.after(b.dispose);
	await a.ensureHead(genesis, signal());
	const outcomes = await Promise.allSettled([
		a.append(genesis, genesis, [block(1)], signal()),
		b.append(genesis, genesis, [block(1)], signal()),
	]);
	assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
	const failed = outcomes.find((r) => r.status === "rejected");
	assert.ok(
		failed?.status === "rejected" && failed.reason instanceof CacheConflict,
	);
	assert.deepEqual(await a.read(0, signal()), [block(1)]);
});

test("failed writes preserve both records and the trusted head", async (t) => {
	const storage = createChainStorage(
		"https://example.test",
		genesis.hash,
		new IDBFactory(),
	);
	t.after(storage.dispose);
	await storage.ensureHead(block(2), signal());
	await storage.append(block(2), genesis, [block(1)], signal());
	await assert.rejects(
		storage.append(
			block(2),
			block(1),
			[{ ...block(2), hash: hash(9) }],
			signal(),
		),
		/trusted head/,
	);
	assert.deepEqual(await storage.read(0, signal()), [block(1)]);
	assert.equal((await storage.head(signal()))?.hash, hash(2));
	// The unique-index failure follows queued writes, so rollback must cover the whole batch.
	await assert.rejects(
		storage.append(
			block(2),
			block(1),
			[block(2), { ...block(3), hash: hash(1) }],
			signal(),
		),
	);
	assert.deepEqual(await storage.read(0, signal()), [block(1)]);
	await storage.append(block(2), block(1), [block(2)], signal());
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(
		storage.append(block(2), block(2), [block(3)], cancelled.signal),
		/abort/i,
	);
	assert.equal((await storage.head(signal()))?.sequence, 2);
	storage.dispose();
	await assert.rejects(storage.head(signal()), /closed/);
});

test("server and library namespaces isolate local history", async (t) => {
	const factory = new IDBFactory();
	const a = createChainStorage("https://a.test", hash(0), factory);
	const b = createChainStorage("https://b.test", hash(0), factory);
	const c = createChainStorage("https://a.test", hash(9), factory);
	for (const storage of [a, b, c]) {
		t.after(storage.dispose);
	}
	await a.ensureHead(genesis, signal());
	await a.append(genesis, genesis, [block(1)], signal());
	assert.equal(await b.head(signal()), null);
	assert.equal(await c.head(signal()), null);
});

test("explicit reset clears owned history and pins without closing other tabs or touching settings", async (t) => {
	const factory = new IDBFactory();
	const first = createChainStorage("https://one.test", genesis.hash, factory);
	const other = createChainStorage("https://two.test", hash(9), factory);
	const settings = createDatabase(factory, "other-application");
	t.after(first.dispose);
	t.after(other.dispose);
	t.after(settings.dispose);
	await first.ensureHead(genesis, signal());
	await first.append(genesis, genesis, [block(1)], signal());
	await other.ensureHead({ sequence: 4, hash: hash(4) }, signal());
	await settings.update("value", () => "preserved", signal());
	await clearChainCaches(signal(), factory);
	assert.equal(await first.head(signal()), null);
	assert.deepEqual(await first.read(0, signal()), []);
	assert.equal(await other.head(signal()), null);
	assert.equal(await settings.read("value", signal()), "preserved");
});
