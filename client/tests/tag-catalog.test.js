import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createTags } from "../src/lib/stores/tags.js";
import { deferred, tick } from "./helpers.js";

test("catalog supersedes reads, keeps same-session suggestions on failure, and clears on lock/disposal", async (t) => {
	const state = writable({
		configured: true,
		unlocked: true,
		busy: false,
		epoch: 0,
	});
	const session = {
		...state,
		get epoch() {
			return get(state).epoch;
		},
		signal: new AbortController().signal,
		credentials: () => ({}),
	};
	const calls = [];
	const catalog = createTags(session, {
		http: {
			getTags({ signal }) {
				const pending = deferred();
				calls.push({ signal, pending });
				return pending.promise;
			},
		},
	});
	t.after(catalog.dispose);
	calls[0].pending.resolve({ tags: ["old"], invalid: 1 });
	await tick();
	assert.deepEqual(get(catalog).tags, ["old"]);
	assert.match(get(catalog).warning, /unavailable/);
	const stale = catalog.refresh();
	const fresh = catalog.refresh();
	assert.equal(calls[1].signal.aborted, true);
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
	assert.equal(calls[4].signal.aborted, true);
	assert.deepEqual(get(catalog).tags, []);
	calls[4].pending.resolve({ tags: ["private"], invalid: 0 });
	assert.equal(await locked, false);
	state.update((v) => ({ ...v, unlocked: true, epoch: 2 }));
	const last = calls.at(-1);
	catalog.dispose();
	assert.equal(last.signal.aborted, true);
	last.pending.resolve({ tags: ["private"], invalid: 0 });
	await tick();
	assert.deepEqual(get(catalog).tags, []);
});
