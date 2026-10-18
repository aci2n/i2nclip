import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type { QuotaApi } from "../src/lib/api.ts";
import { createQuota } from "../src/lib/stores/quota.ts";
import { assertPresent } from "./assert.ts";
import { deferred, testKey } from "./helpers.ts";

function fixture(t: test.TestContext, http: QuotaApi) {
	const controller = new AbortController();
	const session = {
		serverUrl: "https://clip.example",
		key: testKey(),
		signal: controller.signal,
		invalidate: () => controller.abort(),
	};
	const quota = createQuota(session, { http });
	t.after(quota.dispose);
	session.signal.addEventListener("abort", quota.dispose, { once: true });
	return { session, quota };
}
const usage = {
	used_content_bytes: 29,
	file_count: 1,
	max_content_bytes: 536870912,
	max_files: 10000,
	max_file_plaintext_bytes: 33554432,
};
test("quota reads deduplicate and retry errors without persisting stale values", async (t) => {
	let result = deferred<typeof usage>();
	let calls = 0;
	const { quota } = fixture(t, {
		getQuota: async () => {
			calls++;
			return result.promise;
		},
	});
	const first = quota.refresh();
	assert.equal(get(quota).loading, true);
	assert.equal(await quota.refresh(), false);
	assert.equal(calls, 1);
	result.reject(new Error("offline"));
	assert.equal(await first, false);
	assert.equal(get(quota).error, "offline");
	result = deferred<typeof usage>();
	const retry = quota.refresh();
	assert.equal(get(quota).error, "");
	result.resolve(usage);
	assert.equal(await retry, true);
	assert.deepEqual(get(quota).value, usage);
});
test("identity changes abort quota reads and late results cannot replace the new identity's usage", async (t) => {
	const pending: {
		signal?: AbortSignal;
		result: PromiseWithResolvers<typeof usage>;
	}[] = [];
	const { session, quota } = fixture(t, {
		getQuota: ({ signal }) => {
			const result = deferred<typeof usage>();
			pending.push({ signal, result });
			return result.promise;
		},
	});
	const old = quota.refresh();
	session.invalidate();
	assert.equal(assertPresent(pending[0].signal).aborted, true);
	assert.equal(get(quota).value, null);
	const next = fixture(t, { getQuota: async () => usage });
	assert.equal(await next.quota.refresh(), true);
	pending[0].result.resolve({ ...usage, file_count: 999 });
	assert.equal(await old, false);
	assert.deepEqual(get(next.quota).value, usage);
	assert.equal(await quota.refresh(), false);
});
test("disposing the workspace quota aborts its request and ignores a late error", async (t) => {
	const result = deferred<typeof usage>();
	let signal: AbortSignal | undefined;
	const { quota } = fixture(t, {
		getQuota: (args) => {
			signal = args.signal;
			return result.promise;
		},
	});
	const loading = quota.refresh();
	quota.dispose();
	assert.equal(assertPresent(signal).aborted, true);
	result.reject(new Error("late failure"));
	assert.equal(await loading, false);
	assert.deepEqual(get(quota), { value: null, loading: false, error: "" });
});
