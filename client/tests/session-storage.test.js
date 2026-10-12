import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createRepository } from "../src/lib/service/repository.js";
import { tick } from "./helpers.js";

test("a successful header read cannot acknowledge a transaction that later aborts", async () => {
	let transaction;
	const database = {
		createObjectStore() {},
		close() {},
		transaction() {
			const request = { result: undefined };
			transaction = { objectStore: () => ({ get: () => request }) };
			return transaction;
		},
	};
	const repository = createRepository({
		open(name, version) {
			assert.equal(name, "i2nclip-vault");
			assert.equal(version, 1);
			const request = { result: database };
			queueMicrotask(() => {
				request.onupgradeneeded();
				request.onsuccess();
			});
			return request;
		},
	});
	const rejected = assert.rejects(repository.ready, /disk failed/);
	await tick();
	transaction.error = new Error("disk failed");
	transaction.onabort();
	await rejected;
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
			if (!/\.(js|svelte)$/.test(entry.name)) {
				continue;
			}
			const source = await readFile(path, "utf8");
			assert(
				!/indexedDB|localStorage|sessionStorage|browser\.storage|platform\.(?:local|session)|\.privateKey\b|\.\/api\.js|protocol\/(?:crypto|vault|identity)\.js/.test(
					source,
				),
				`${path.pathname} crosses the service boundary`,
			);
		}
	}
	for (const name of ["stores", "components", "views"]) {
		await inspect(new URL(`../src/lib/${name}/`, import.meta.url));
	}
});
