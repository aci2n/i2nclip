import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createTags } from "../src/lib/stores/tags.ts";
import { assertPresent } from "./assert.ts";
import { deferred, testKey, tick } from "./helpers.ts";

function fixture(t: test.TestContext) {
	const controller = new AbortController();
	const session = {
		serverUrl: "https://clip.example",
		key: testKey(),
		signal: controller.signal,
	};
	const calls: {
		signal?: AbortSignal;
		pending: ReturnType<
			typeof deferred<{
				tags: string[];
				invalid: number;
			}>
		>;
	}[] = [];
	const catalog = createTags(session, {
		http: {
			getTags({ signal }) {
				const pending = deferred<{
					tags: string[];
					invalid: number;
				}>();
				calls.push({ signal, pending });
				return pending.promise;
			},
		},
	});
	t.after(catalog.dispose);
	controller.signal.addEventListener("abort", catalog.dispose, { once: true });
	return { end: () => controller.abort(), catalog, calls };
}
test("catalog supersedes reads, keeps same-session suggestions on failure, and clears on lock/disposal", async (t) => {
	const { end, catalog, calls } = fixture(t);
	calls[0].pending.resolve({ tags: ["old"], invalid: 1 });
	await tick();
	assert.deepEqual(get(catalog).tags, ["old"]);
	assert.match(get(catalog).warning, /unavailable/);
	const stale = catalog.refresh();
	const fresh = catalog.refresh();
	assert.equal(assertPresent(calls[1].signal).aborted, true);
	calls[2].pending.resolve({ tags: ["fresh"], invalid: 0 });
	assert.equal(await fresh, true);
	calls[1].pending.resolve({ tags: ["stale"], invalid: 0 });
	assert.equal(await stale, false);
	assert.deepEqual(get(catalog).tags, ["fresh"]);
	const failed = catalog.refresh();
	calls[3].pending.reject(new Error("offline"));
	assert.equal(await failed, false);
	assert.deepEqual(get(catalog).tags, ["fresh"]);
	assert.equal(get(catalog).error, "offline");
	const locked = catalog.refresh();
	end();
	assert.equal(assertPresent(calls[4].signal).aborted, true);
	assert.deepEqual(get(catalog).tags, []);
	calls[4].pending.resolve({ tags: ["private"], invalid: 0 });
	assert.equal(await locked, false);
	const next = fixture(t);
	next.calls[0].pending.resolve({ tags: ["new"], invalid: 0 });
	await tick();
	assert.deepEqual(get(next.catalog).tags, ["new"]);
	const last = calls.at(-1);
	catalog.dispose();
	assert.equal(assertPresent(assertPresent(last).signal).aborted, true);
	assertPresent(last).pending.resolve({ tags: ["private"], invalid: 0 });
	await tick();
	assert.deepEqual(get(catalog).tags, []);
});
test("a disposed catalog ignores late failures and cannot start more requests", async (t) => {
	const { catalog, calls } = fixture(t);
	catalog.dispose();
	calls[0].pending.reject(new Error("late failure"));
	await tick();
	assert.equal(await catalog.refresh(), false);
	assert.equal(calls.length, 1);
	assert.deepEqual(get(catalog).tags, []);
	assert.equal(get(catalog).error, "");
});
