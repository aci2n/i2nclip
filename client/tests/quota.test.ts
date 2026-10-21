import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type { ChainApi } from "../src/lib/services/library-api.ts";

type QuotaApi = Pick<ChainApi, "quota">;

import { createQuota } from "../src/lib/stores/quota.ts";
import { assertPresent } from "./assert.ts";
import { deferred } from "./helpers.ts";

function fixture(t: test.TestContext, http: QuotaApi) {
	const controller = new AbortController();
	const session = {
		serverUrl: "https://clip.example",
		signal: controller.signal,
		invalidate: () => controller.abort(),
	};
	const quota = createQuota(http, session.signal);
	t.after(quota.dispose);
	session.signal.addEventListener("abort", quota.dispose, { once: true });
	return { session, quota };
}
const usage = {
	logBytes: 0,
	usedBytes: 29,
	retainedFiles: 1,
	maximumBytes: 536870912,
	maximumFiles: 10000,
};
test("quota reads deduplicate and retry errors without persisting stale values", async (t) => {
	let result = deferred<typeof usage>();
	let calls = 0;
	const { quota } = fixture(t, {
		quota: async () => {
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
		quota: (signal) => {
			const result = deferred<typeof usage>();
			pending.push({ signal, result });
			return result.promise;
		},
	});
	const old = quota.refresh();
	session.invalidate();
	assert.equal(assertPresent(pending[0].signal).aborted, true);
	assert.equal(get(quota).value, null);
	const next = fixture(t, { quota: async () => usage });
	assert.equal(await next.quota.refresh(), true);
	pending[0].result.resolve({ ...usage, retainedFiles: 999 });
	assert.equal(await old, false);
	assert.deepEqual(get(next.quota).value, usage);
	assert.equal(await quota.refresh(), false);
});
test("disposing the workspace quota aborts its request and ignores a late error", async (t) => {
	const result = deferred<typeof usage>();
	let signal: AbortSignal | undefined;
	const { quota } = fixture(t, {
		quota: (requestSignal) => {
			signal = requestSignal;
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

test("live quota instances sharing an API keep requests and disposal independent", async (t) => {
	const requests: {
		signal: AbortSignal | undefined;
		result: ReturnType<typeof deferred<typeof usage>>;
	}[] = [];
	const http: QuotaApi = {
		quota: (signal) => {
			const result = deferred<typeof usage>();
			requests.push({ signal, result });
			return result.promise;
		},
	};
	const first = fixture(t, http).quota;
	const second = fixture(t, http).quota;
	const firstRead = first.refresh();
	const secondRead = second.refresh();
	assert.equal(requests.length, 2);
	first.dispose();
	assert.equal(assertPresent(requests[0].signal).aborted, true);
	assert.equal(assertPresent(requests[1].signal).aborted, false);
	assert.equal(get(second).loading, true);
	requests[0].result.resolve({ ...usage, retainedFiles: 999 });
	requests[1].result.resolve(usage);
	assert.equal(await firstRead, false);
	assert.equal(await secondRead, true);
	assert.deepEqual(get(first), { value: null, loading: false, error: "" });
	assert.deepEqual(get(second).value, usage);
});
