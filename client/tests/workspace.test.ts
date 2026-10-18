import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { DEFAULT_MAX_FILE_PLAINTEXT_BYTES } from "../src/lib/api.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";
import { createWorkspace } from "../src/lib/stores/workspace.ts";
import { deferred, testKey, tick } from "./helpers.ts";
import { documentResponse } from "./msgpack-response.ts";

const usage = {
	used_content_bytes: 0,
	file_count: 0,
	max_content_bytes: 536870912,
	max_files: 10000,
	max_file_plaintext_bytes: 64 * 1024 * 1024,
};

test("workspace loads quota without Settings, survives subscriber changes, and falls back after failure", async (t) => {
	const controller = new AbortController();
	const started = deferred();
	let response = deferred<Response>();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
		if (String(url).endsWith("/api/quota")) {
			calls++;
			started.resolve();
			return response.promise;
		}
		if (String(url).includes("/api/tags")) {
			return documentResponse({ tags: [] });
		}
		return documentResponse({ media: [], next: null });
	});
	const preferences = createPreferences({ getItem: () => null, setItem() {} });
	const workspace = createWorkspace(
		{
			serverUrl: "https://clip.example",
			key: testKey(),
			signal: controller.signal,
		},
		preferences,
	);
	t.after(workspace.dispose);
	assert.equal(get(workspace.quota).loading, true);
	assert.equal(
		workspace.uploads.getMaxFilePlaintextBytes(),
		DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
	);
	await started.promise;
	const stop = workspace.quota.subscribe(() => {});
	stop();
	response.resolve(documentResponse(usage));
	await tick();
	assert.equal(
		workspace.uploads.getMaxFilePlaintextBytes(),
		usage.max_file_plaintext_bytes,
	);
	assert.equal(calls, 1);
	// A real zero limit must not select the fallback.
	response = deferred<Response>();
	const zero = workspace.quota.refresh();
	response.resolve(documentResponse({ ...usage, max_file_plaintext_bytes: 0 }));
	await zero;
	assert.equal(workspace.uploads.getMaxFilePlaintextBytes(), 0);
	response = deferred<Response>();
	const failed = workspace.quota.refresh();
	response.resolve(documentResponse({ error: "offline" }, { status: 503 }));
	await failed;
	assert.equal(
		workspace.uploads.getMaxFilePlaintextBytes(),
		DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
	);
	assert.equal(get(workspace.quota).error, "offline");
});

test("ending a workspace cancels quota reads and ignores late success", async (t) => {
	const controller = new AbortController();
	const started = deferred<AbortSignal>();
	const response = deferred<Response>();
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, options: RequestInit = {}) => {
			if (String(url).endsWith("/api/quota")) {
				assert(options.signal);
				started.resolve(options.signal);
				return response.promise;
			}
			return documentResponse({ tags: [], media: [], next: null });
		},
	);
	const workspace = createWorkspace(
		{
			serverUrl: "https://clip.example",
			key: testKey(),
			signal: controller.signal,
		},
		createPreferences({ getItem: () => null, setItem() {} }),
	);
	t.after(workspace.dispose);
	const signal = await started.promise;
	controller.abort();
	assert.equal(signal.aborted, true);
	response.resolve(documentResponse(usage));
	await tick();
	assert.equal(get(workspace.quota).value, null);
	assert.equal(await workspace.quota.refresh(), false);
});
