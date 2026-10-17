import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createTags } from "../src/lib/stores/tags.ts";
import { assertPresent } from "./assert.ts";
import { deferred, testKey, tick } from "./helpers.ts";

function fixture(t: test.TestContext, { busy = false } = {}) {
	const state = writable({
		configured: true,
		unlocked: true,
		busy,
		epoch: 0,
	});
	const session = {
		...state,
		get epoch() {
			return get(state).epoch;
		},
		signal: new AbortController().signal,
		credentials: () => ({ serverUrl: "https://clip.example", key: testKey }),
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
	return { state, catalog, calls };
}
test("catalog supersedes reads, keeps same-session suggestions on failure, and clears on lock/disposal", async (t) => {
	const { state, catalog, calls } = fixture(t);
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
	state.update((v) => ({ ...v, unlocked: false, epoch: 1 }));
	assert.equal(assertPresent(calls[4].signal).aborted, true);
	assert.deepEqual(get(catalog).tags, []);
	calls[4].pending.resolve({ tags: ["private"], invalid: 0 });
	assert.equal(await locked, false);
	state.update((v) => ({ ...v, unlocked: true, epoch: 2 }));
	const last = calls.at(-1);
	catalog.dispose();
	assert.equal(assertPresent(assertPresent(last).signal).aborted, true);
	assertPresent(last).pending.resolve({ tags: ["private"], invalid: 0 });
	await tick();
	assert.deepEqual(get(catalog).tags, []);
});
test("catalog coalesces busy refreshes, keeps suggestions and waits for explicit retry after failure", async (t) => {
	const { state, catalog, calls } = fixture(t, { busy: true });
	assert.equal(calls.length, 0);
	assert.equal(await catalog.refresh(), false);
	assert.equal(await catalog.refresh(), false);
	state.update((v) => ({ ...v, busy: false }));
	assert.equal(calls.length, 1);
	calls[0].pending.resolve({ tags: ["old"], invalid: 0 });
	await tick();
	state.update((v) => ({ ...v, busy: true }));
	assert.equal(await catalog.refresh(), false);
	assert.equal(await catalog.refresh(), false);
	assert.deepEqual(get(catalog).tags, ["old"]);
	assert.equal(get(catalog).loading, false);
	assert.equal(calls.length, 1);
	state.update((v) => ({ ...v, busy: false }));
	assert.equal(calls.length, 2);
	state.update((v) => ({ ...v, busy: false }));
	assert.equal(calls.length, 2);
	calls[1].pending.reject(new Error("offline"));
	await tick();
	assert.deepEqual(get(catalog).tags, ["old"]);
	assert.equal(get(catalog).error, "offline");
	state.update((v) => ({ ...v, busy: true }));
	state.update((v) => ({ ...v, busy: false }));
	assert.equal(calls.length, 2);
	const retry = catalog.refresh();
	calls[2].pending.resolve({ tags: ["fresh"], invalid: 0 });
	assert.equal(await retry, true);
	assert.deepEqual(get(catalog).tags, ["fresh"]);
	assert.equal(get(catalog).error, "");
});
test("catalog drops deferred work on lock and loads only the new identity after unlock", async (t) => {
	const { state, catalog, calls } = fixture(t);
	calls[0].pending.resolve({ tags: ["private"], invalid: 0 });
	await tick();
	state.update((v) => ({ ...v, busy: true }));
	await catalog.refresh();
	state.update((v) => ({ ...v, unlocked: false, busy: false, epoch: 1 }));
	assert.deepEqual(get(catalog).tags, []);
	assert.equal(calls.length, 1);
	state.update((v) => ({ ...v, unlocked: true, busy: true, epoch: 2 }));
	assert.equal(calls.length, 1);
	state.update((v) => ({ ...v, busy: false }));
	assert.equal(calls.length, 2);
	calls[1].pending.resolve({ tags: ["new identity"], invalid: 0 });
	await tick();
	assert.deepEqual(get(catalog).tags, ["new identity"]);
});
test("disposing the catalog discards a deferred refresh", async (t) => {
	const { state, catalog, calls } = fixture(t, { busy: true });
	await catalog.refresh();
	catalog.dispose();
	state.update((v) => ({ ...v, busy: false }));
	await tick();
	assert.equal(calls.length, 0);
	assert.deepEqual(get(catalog).tags, []);
});
