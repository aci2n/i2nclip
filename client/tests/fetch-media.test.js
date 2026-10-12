import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fetchMedia } from "../src/extension/fetch-media.js";

function tab(t, fetch) {
	const context = vm.createContext({ AbortController, Uint8Array, fetch });
	const previous = globalThis.browser;
	t.after(() => {
		globalThis.browser = previous;
	});
	globalThis.browser = {
		scripting: {
			async executeScript({ func, args, target }) {
				assert.deepEqual(target, { tabId: 7, frameIds: [2] });
				context.args = args;
				return [
					{
						result: await vm.runInContext(
							`(${func.toString()})(...args)`,
							context,
						),
					},
				];
			},
		},
	};
	return context;
}

// Firefox provides this global; each test supplies an isolated-world shim.
globalThis.browser = {};
const source = { srcUrl: "blob:test", tabId: 7, frameId: 2 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const phase of ["headers", "body"]) {
	test(`tab cancellation aborts stalled ${phase} and clears frame state`, async (t) => {
		let remoteSignal;
		let released = false;
		const context = tab(t, async (_url, { signal }) => {
			remoteSignal = signal;
			const pending = () =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			if (phase === "headers") {
				return pending();
			}
			return {
				ok: true,
				body: {
					getReader: () => ({
						read: pending,
						cancel: async () => {},
						releaseLock: () => {
							released = true;
						},
					}),
				},
			};
		});
		const controller = new AbortController();
		const request = fetchMedia(source, controller.signal);
		await tick();
		controller.abort();
		await assert.rejects(request, { name: "AbortError" });
		await tick();
		assert.equal(remoteSignal.aborted, true);
		assert.equal(context.__i2nclipMediaRequests, undefined);
		if (phase === "body") {
			assert.equal(released, true);
		}
	});
}

test("cancelling one tab request preserves another request", async (t) => {
	let complete;
	let calls = 0;
	const context = tab(t, (_url, { signal }) => {
		calls++;
		return new Promise((resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
			if (calls === 2) {
				complete = () =>
					resolve(
						new Response(new Uint8Array([1, 2]), {
							headers: { "content-type": "image/png" },
						}),
					);
			}
		});
	});
	const controller = new AbortController();
	const first = fetchMedia(source, controller.signal);
	const second = fetchMedia(source);
	await tick();
	controller.abort();
	await assert.rejects(first, { name: "AbortError" });
	await tick();
	assert.equal(context.__i2nclipMediaRequests.size, 1);
	complete();
	const result = await second;
	assert.deepEqual(
		new Uint8Array(await result.arrayBuffer()),
		new Uint8Array([1, 2]),
	);
	assert.equal(result.headers.get("content-type"), "image/png");
	assert.equal(context.__i2nclipMediaRequests, undefined);
});

test("tab reader releases its lock even when cancellation rejects", async (t) => {
	let released = false;
	const context = tab(t, async () => ({
		ok: true,
		body: {
			getReader: () => ({
				read: async () => {
					throw new Error("broken stream");
				},
				cancel: async () => {
					throw new Error("cancel failed");
				},
				releaseLock: () => {
					released = true;
				},
			}),
		},
	}));
	await assert.rejects(fetchMedia(source), /cancel failed/);
	assert.equal(released, true);
	assert.equal(context.__i2nclipMediaRequests, undefined);
});

test("aborting during frame registration never starts a fetch", async (t) => {
	let fetched = false;
	const context = tab(t, async () => {
		fetched = true;
	});
	const execute = browser.scripting.executeScript;
	let registered;
	browser.scripting.executeScript = async (options) => {
		const result = await execute(options);
		if (options.args.length === 2 && !registered) {
			await new Promise((resolve) => {
				registered = resolve;
			});
		}
		return result;
	};
	const controller = new AbortController();
	const request = fetchMedia(source, controller.signal);
	await tick();
	controller.abort();
	registered();
	await assert.rejects(request, { name: "AbortError" });
	assert.equal(fetched, false);
	assert.equal(context.__i2nclipMediaRequests, undefined);
});

test("failed fetch injection removes its registered controller", async (t) => {
	const context = tab(t, async () => {});
	const execute = browser.scripting.executeScript;
	browser.scripting.executeScript = (options) => {
		if (options.args.length === 4) {
			return Promise.reject(new Error("frame unavailable"));
		}
		return execute(options);
	};
	await assert.rejects(fetchMedia(source), /frame unavailable/);
	assert.equal(context.__i2nclipMediaRequests, undefined);
});
