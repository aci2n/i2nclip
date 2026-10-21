import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { createDatabase } from "../src/lib/storage/database.ts";

const signal = () => new AbortController().signal;
test("independent storage owners serialize transactions and roll back failed changes", async (t) => {
	const factory = new IDBFactory();
	const first = createDatabase(factory);
	const second = createDatabase(factory);
	t.after(first.dispose);
	t.after(second.dispose);
	const { update } = first;
	await update<number>("counter", () => 0, signal());
	await Promise.all([
		update<number>("counter", (value) => (value ?? 0) + 1, signal()),
		second.update<number>("counter", (value) => (value ?? 0) + 1, signal()),
	]);
	await assert.rejects(
		first.update(
			"counter",
			() => {
				throw new Error("Rejected change");
			},
			signal(),
		),
		/Rejected change/,
	);
	assert.equal(await second.read("counter", signal()), 2);
	first.dispose();
	first.dispose();
	await assert.rejects(first.read("counter", signal()), /closed/);
	assert.equal(await second.read("counter", signal()), 2);
});
test("disposing an opening connection rejects pending reads and cannot reopen it", async () => {
	const database = createDatabase(new IDBFactory());
	const pending = database.read("missing", signal());
	database.dispose();
	await assert.rejects(pending, { name: "AbortError" });
	await assert.rejects(database.read("missing", signal()), /closed/);
});
