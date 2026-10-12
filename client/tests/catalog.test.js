import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createServiceEngine } from "../src/lib/service/engine.js";
import { createLibraryClient } from "../src/lib/service/scope.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { wrapPrivateKey } from "../src/lib/protocol/vault.js";
import { engineClient, memoryRepository, until } from "./service-helpers.js";
import { deferred } from "./helpers.js";

function catalogRepository(records) {
	const rows = new Map(records.map((row) => [row.id, structuredClone(row)])),
		scopes = new Map();
	const scope = (id) => {
		if (scopes.has(id)) return scopes.get(id);
		const repo = memoryRepository(rows.get(id)?.identity);
		const base = repo.setConfig;
		repo.setConfig = async (identity, options) => {
			if (!rows.has(id)) throw new Error("Library removed");
			if (
				identity.publicKey &&
				[...rows.values()].some(
					(row) =>
						row.id !== id &&
						row.identity?.publicKey === identity.publicKey &&
						row.identity.serverUrl === identity.serverUrl,
				)
			)
				throw new Error("already saved");
			await base(identity, options);
			rows.get(id).identity = structuredClone(identity);
		};
		repo.close = () => {};
		scopes.set(id, repo);
		return repo;
	};
	return {
		libraries: async () => structuredClone([...rows.values()]),
		scope,
		jobs: async () =>
			(
				await Promise.all([...scopes.values()].map((repo) => repo.jobs()))
			).flat(),
		putLibrary: async (row) => rows.set(row.id, structuredClone(row)),
		renameLibrary: async (id, name) => {
			rows.get(id).name = name;
		},
		deleteLibraries: async (ids, replacement) => {
			for (const id of ids) {
				await scope(id).reset();
				rows.delete(id);
			}
			if (replacement) rows.set(replacement.id, replacement);
		},
		close() {},
	};
}
async function fixture(t, extra = {}) {
	const keys = await Promise.all([generatePrivateKey(), generatePrivateKey()]);
	const records = await Promise.all(
		keys.map(async (key, index) => ({
			id: `lib-${index}`,
			name: index ? "Shared" : "Personal",
			identity: {
				serverUrl: "https://clip.example",
				publicKey: key.publicKey,
				wrappedKey: await wrapPrivateKey(key.privateKey, "password123", 1),
				identityGeneration: `gen-${index}`,
			},
		})),
	);
	const repository = catalogRepository(records);
	const engine = createServiceEngine({
		repository,
		defaultServerUrl: "https://clip.example",
		api: { list: async () => ({ items: [], next: null }) },
		...extra,
	});
	t.after(engine.dispose);
	const root = engineClient(engine);
	t.after(root.dispose);
	await root.ready;
	const a = createLibraryClient(root, "lib-0"),
		b = createLibraryClient(root, "lib-1");
	t.after(a.dispose);
	t.after(b.dispose);
	return { root, a, b, engine, repository, keys };
}
test("library selection and unlock are independent; catalog renames retain identity", async (t) => {
	const f = await fixture(t);
	await f.a.command("identity.unlock", { password: "password123" });
	assert.equal(get(f.a).session.unlocked, true);
	assert.equal(get(f.b).session.unlocked, false);
	await f.root.command("libraries.rename", {
		libraryId: "lib-0",
		name: "Private",
	});
	assert.equal(
		(await f.repository.scope("lib-0").getConfig()).publicKey,
		f.keys[0].publicKey,
	);
	assert.equal(get(f.b).catalog[0].name, "Private");
	await assert.rejects(
		f.root.command("libraries.add", { name: "PRIVATE" }),
		/already used/,
	);
	f.a.select("lib-1");
	assert.equal(get(f.a).session.unlocked, false);
	assert.equal(get(f.b).libraryId, "lib-1");
});
test("switching tabs does not retarget a running upload; the owner has one upload lane", async (t) => {
	const gate = deferred();
	const seen = [];
	let active = 0,
		max = 0;
	const f = await fixture(t, {
		upload: async (options) => {
			active++;
			max = Math.max(max, active);
			seen.push(options.credentials.privateKey);
			if (seen.length === 1) await gate.promise;
			active--;
			return { id: `media-${seen.length}` };
		},
	});
	await f.a.command("identity.unlock", { password: "password123" });
	await f.b.command("identity.unlock", { password: "password123" });
	await f.a.command("uploads.submit", {
		sources: [
			{
				blob: new Blob(["personal"], { type: "text/plain" }),
				name: "personal.txt",
			},
		],
	});
	await until(() => seen.length === 1);
	await f.b.command("uploads.submit", {
		sources: [
			{
				blob: new Blob(["shared"], { type: "text/plain" }),
				name: "shared.txt",
			},
		],
	});
	f.a.select("lib-1");
	gate.resolve();
	await until(() =>
		Object.values(get(f.root).libraries).every(
			(state) => state.uploads[0]?.status === "completed",
		),
	);
	assert.equal(max, 1);
	assert.deepEqual(
		seen,
		f.keys.map((key) => key.privateKey),
	);
	assert.equal(get(f.root).libraries["lib-0"].uploads[0].name, "personal.txt");
});
test("forgetting one library preserves the other unlocked identity and rejects stale commands", async (t) => {
	const f = await fixture(t);
	await f.b.command("identity.unlock", { password: "password123" });
	await f.root.command("libraries.forget", { libraryId: "lib-0" });
	assert.equal(get(f.b).session.unlocked, true);
	await assert.rejects(
		f.root.command("identity.unlock", {
			libraryId: "lib-0",
			password: "password123",
			epoch: 0,
		}),
		/saved library|context ended/,
	);
	assert.equal((await f.repository.libraries()).length, 1);
});
test("an unlocked library can authorize a new independent library on its server", async (t) => {
	let granted;
	const f = await fixture(t, {
		api: {
			list: async () => ({ items: [], next: null }),
			registerAuthenticatedKey: async (options) => {
				granted = options;
			},
		},
	});
	await f.a.command("identity.unlock", { password: "password123" });
	const id = await f.root.command("libraries.add", { name: "Team" });
	await f.root.command("identity.create", {
		libraryId: id,
		epoch: 0,
		serverUrl: "https://clip.example",
		password: "new-password",
		authorizerLibraryId: "lib-0",
	});
	assert.equal(granted.privateKey, f.keys[0].privateKey);
	assert.notEqual(granted.publicKey, f.keys[0].publicKey);
	assert.equal(get(f.root).libraries[id].session.unlocked, true);
	assert.equal(get(f.a).session.publicKey, f.keys[0].publicKey);
});

test("failed catalog removal restores the persisted library locked and leaves other libraries running", async (t) => {
	const f = await fixture(t);
	await f.a.command("identity.unlock", { password: "password123" });
	await f.b.command("identity.unlock", { password: "password123" });
	f.repository.deleteLibraries = async () => {
		throw new Error("disk failed");
	};
	await assert.rejects(
		f.root.command("libraries.forget", { libraryId: "lib-0" }),
		/disk failed/,
	);
	assert.equal(get(f.root).catalog.length, 2);
	assert.equal(get(f.a).session.configured, true);
	assert.equal(get(f.a).session.unlocked, false);
	assert.equal(get(f.b).session.unlocked, true);
	await f.a.command("identity.unlock", { password: "password123" });
	assert.equal(get(f.a).session.unlocked, true);
});
