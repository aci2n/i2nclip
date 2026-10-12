import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createRepository } from "../src/lib/service/repository.js";
import { tick } from "./helpers.js";

function databaseFixture() {
	let opened, current;
	const stores = [];
	const database = {
		createObjectStore: (name) => stores.push(name),
		close() {},
		transaction(names, mode) {
			const requests = [];
			const tx = {
				names,
				mode,
				requests,
				objectStore: (name) => ({
					getAll: () => {
						const request = { name };
						requests.push(request);
						return request;
					},
					get: (key) => {
						const request = { name, key };
						requests.push(request);
						return request;
					},
					put: (value, key) => requests.push({ name, value, key }),
					delete: (key) => requests.push({ name, key, deleted: true }),
					clear: () => requests.push({ name, cleared: true }),
				}),
				abort: () => tx.onabort(),
			};
			current = tx;
			return tx;
		},
	};
	const repository = createRepository({
		open(name, version) {
			assert.equal(name, "i2nclip-libraries");
			assert.equal(version, 1);
			opened = { result: database };
			queueMicrotask(() => {
				opened.onupgradeneeded();
				opened.onsuccess();
			});
			return opened;
		},
	});
	return {
		repository,
		stores,
		get tx() {
			return current;
		},
	};
}

test("a successful database request cannot acknowledge a transaction that later aborts", async () => {
	const f = databaseFixture();
	await f.repository.ready;
	const read = f.repository.libraries();
	const rejected = assert.rejects(read, /disk failed/);
	await tick();
	f.tx.requests[0].result = { serverUrl: "https://saved.example" };
	f.tx.requests[0].onsuccess();
	f.tx.error = new Error("disk failed");
	f.tx.onabort();
	await rejected;
});

test("source and job acceptance wait for one atomic database commit", async () => {
	const f = databaseFixture();
	await f.repository.ready;
	let committed = false;
	const saving = f.repository
		.scope("library")
		.putJob({ id: "one", status: "queued" }, new Blob(["source"]))
		.then(() => {
			committed = true;
		});
	await tick();
	assert.equal(committed, false);
	assert.deepEqual(f.tx.names, ["jobs", "sources"]);
	assert.equal(f.tx.requests.length, 2);
	f.tx.oncomplete();
	await saving;
	assert.equal(committed, true);
	assert.deepEqual(f.stores, ["libraries", "jobs", "sources"]);
});

test("browser UI accesses no raw identity storage, credentials or API workflows", async () => {
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
			if (!/\.(js|svelte)$/.test(entry.name)) continue;
			const source = await readFile(path, "utf8");
			assert(
				!/indexedDB|localStorage|sessionStorage|browser\.storage|platform\.(?:local|session)|\.privateKey\b|\.\/api\.js|protocol\/(?:crypto|vault|identity)\.js/.test(
					source,
				),
				`${path.pathname} crosses the service boundary`,
			);
		}
	}
	for (const name of ["stores", "components", "views"])
		await inspect(new URL(`../src/lib/${name}/`, import.meta.url));
});
