import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test, { beforeEach } from "node:test";
import { createSessionStorage } from "../src/lib/stores/session-storage.js";
import { deferred, installSessionLocks, tick } from "./helpers.js";

beforeEach(installSessionLocks);

function fixture() {
	let value = {};
	const area = {
		get: async () => ({ ...value }),
		set: async (next) => {
			value = { ...value, ...next };
		},
		remove: async (key) => {
			delete value[key];
		},
		clear: async () => {
			value = {};
		},
	};
	const controller = new AbortController();
	const platform = { local: area, session: area };
	return {
		platform,
		controller,
		storage: createSessionStorage(platform, controller.signal),
	};
}

test("storage capabilities expire and cannot read or write after releasing the mutex", async () => {
	const f = fixture();
	let escaped;
	await f.storage.transaction(async (tx) => {
		escaped = tx;
		await tx.local.set({ key: "saved" });
	});
	for (const area of [escaped.local, escaped.session]) {
		for (const method of ["get", "set", "remove", "clear"])
			assert.throws(
				() => area[method]({ key: "wrong" }),
				/transaction has ended/,
			);
	}
	assert.deepEqual(await f.platform.local.get(), { key: "saved" });
});

test("a throwing callback retains the mutex until its started storage write settles", async () => {
	const f = fixture();
	const started = deferred(),
		finish = deferred();
	f.platform.local.set = async () => {
		started.resolve();
		await finish.promise;
	};
	const first = f.storage.transaction(async (tx) => {
		tx.local.set({ key: "saved" });
		await started.promise;
		throw new Error("callback failed");
	});
	const rejected = assert.rejects(first, /callback failed/);
	await started.promise;
	let secondEntered = false;
	const second = f.storage.transaction(() => {
		secondEntered = true;
	});
	await tick();
	assert.equal(secondEntered, false);
	finish.resolve();
	await rejected;
	await second;
	assert.equal(secondEntered, true);
});

test("chained writes from a throwing callback cannot overlap the next transaction", async () => {
	const f = fixture();
	const started = deferred(),
		finishFirst = deferred(),
		finishChained = deferred();
	let chainedRunning = false;
	let chained;
	f.platform.local.set = async ({ key }) => {
		if (key === "first") {
			started.resolve();
			await finishFirst.promise;
		} else {
			chainedRunning = true;
			await finishChained.promise;
			chainedRunning = false;
		}
	};
	const first = f.storage.transaction((tx) => {
		chained = tx.local
			.set({ key: "first" })
			.then(() => tx.local.set({ key: "chained" }))
			.catch((error) => {
				// Closing capability admission before draining is also safe.
				assert.match(error.message, /transaction has ended/);
			});
		throw new Error("callback failed");
	});
	const rejected = assert.rejects(first, /callback failed/);
	await started.promise;
	let enteredWhileWriting;
	const second = f.storage.transaction(() => {
		enteredWhileWriting = chainedRunning;
	});
	try {
		finishFirst.resolve();
		await tick();
		assert.notEqual(enteredWhileWriting, true);
	} finally {
		finishFirst.resolve();
		finishChained.resolve();
		await Promise.all([rejected, second, chained]);
	}
	assert.equal(enteredWhileWriting, false);
});

test("unawaited storage writes finish before a transaction releases its mutex", async () => {
	const f = fixture();
	const finish = deferred();
	f.platform.local.set = () => finish.promise;
	let settled = false;
	const writing = f.storage
		.transaction((tx) => {
			tx.local.set({ key: "saved" });
		})
		.then(() => {
			settled = true;
		});
	await tick();
	assert.equal(settled, false);
	finish.resolve();
	await writing;
	assert.equal(settled, true);
});

test("aborted queued transactions never receive storage access", async () => {
	const f = fixture();
	const finish = deferred(),
		entered = deferred();
	const held = f.storage.transaction(async () => {
		entered.resolve();
		await finish.promise;
	});
	await entered.promise;
	const cancel = new AbortController();
	const queued = f.storage.transaction(
		() => assert.fail("aborted transaction entered"),
		cancel.signal,
	);
	const rejected = assert.rejects(queued, { name: "AbortError" });
	cancel.abort();
	finish.resolve();
	await held;
	await rejected;
});

test("missing mutex support rejects reads as well as writes", async () => {
	const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: undefined,
	});
	try {
		await assert.rejects(
			fixture().storage.transaction(() => assert.fail("unguarded access")),
			/coordination is unavailable/,
		);
	} finally {
		Object.defineProperty(navigator, "locks", previous);
	}
});

test("application storage accesses stay inside the session storage boundary", async () => {
	const root = new URL("../src/", import.meta.url);
	async function inspect(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = new URL(
				entry.name + (entry.isDirectory() ? "/" : ""),
				directory,
			);
			if (entry.isDirectory()) {
				await inspect(path);
				continue;
			}
			if (
				!/\.(js|svelte)$/.test(entry.name) ||
				entry.name === "session-storage.js"
			)
				continue;
			const source = await readFile(path, "utf8");
			assert(
				!/platform\.(?:local|session)\b/.test(source),
				`${path.pathname} bypasses session storage`,
			);
		}
	}
	await inspect(root);
});

test("successful callbacks also close capability admission before draining writes", async () => {
	const f = fixture();
	const started = deferred(),
		finish = deferred();
	let writes = 0;
	let chained;
	f.platform.local.set = async () => {
		writes++;
		started.resolve();
		await finish.promise;
	};
	const writing = f.storage.transaction((tx) => {
		chained = tx.local
			.set({ key: "first" })
			.then(() => tx.local.set({ key: "late" }));
	});
	const rejected = assert.rejects(
		Promise.resolve().then(async () => {
			await started.promise;
			await chained;
		}),
		/transaction has ended/,
	);
	await started.promise;
	await tick();
	finish.resolve();
	await writing;
	await rejected;
	assert.equal(writes, 1);
});
