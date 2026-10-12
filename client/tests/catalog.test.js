import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { createServiceEngine } from "../src/lib/service/engine.js";
import { createLibraryClient } from "../src/lib/service/scope.js";
import { createSetup } from "../src/lib/stores/setup.js";
import { deferred } from "./helpers.js";
import { engineClient, memoryRepository, until } from "./service-helpers.js";

test("authorization follows the owner source server, clears closed drafts, and aborts when the source changes", async (t) => {
	const sending = deferred();
	let granted;
	const f = await fixture(t, {
		api: {
			list: async () => ({ items: [], next: null }),
			registerAuthenticatedKey: (options) => {
				granted = options;
				return sending.promise;
			},
		},
	});
	await f.b.command("identity.setServer", {
		serverUrl: "https://other.example",
	});
	const setup = createSetup(
		f.root,
		{ confirm: () => true },
		() => "lib-1",
		() => assert.fail("Must not promote stale authorization"),
	);
	t.after(setup.dispose);
	setup.start();
	assert.equal(get(setup.settings).authorizerLibraryId, "lib-1");
	assert.equal(get(setup.settings).server, "https://other.example");
	setup.settings.edit("server", "https://invitation.example");
	setup.settings.edit("libraryName", "Separate");
	setup.settings.edit("authorizePassword", "new-password");
	setup.close();
	setup.start();
	assert.equal(get(setup.settings).libraryName, "Personal 2");
	setup.settings.edit("libraryName", "Separate");
	setup.settings.edit("server", "https://invitation.example");
	const creating = setup.settings.create();
	await until(() => granted);
	assert.equal(granted.serverUrl, "https://other.example");
	assert.equal(granted.privateKey, f.keys[1].privateKey);
	assert.equal(get(setup.settings).server, "https://invitation.example");
	await f.b.command("identity.setServer", {
		serverUrl: "https://changed.example",
	});
	sending.resolve();
	assert.equal(await creating, false);
	assert.equal(get(f.root).catalog.length, 2);
	assert.equal(get(f.root).setup, null);
	assert.equal((await f.repository.libraries()).length, 2);
});

test("global reset clears temporary setup and its form secrets", async (t) => {
	const f = await fixture(t, {
		api: {
			list: async () => ({ items: [], next: null }),
			registerAuthenticatedKey: async () => {
				throw new Error("offline");
			},
		},
	});
	const setup = createSetup(
		f.root,
		{ confirm: () => true },
		() => "lib-0",
		() => {},
	);
	t.after(setup.dispose);
	setup.start();
	setup.settings.edit("libraryName", "Pending");
	setup.settings.edit("authorizePassword", "new-password");
	await setup.settings.create();
	assert.equal((await f.repository.libraries()).length, 2);
	await f.root.command("libraries.reset");
	assert.equal(get(setup).open, false);
	assert.equal(get(setup.settings).otc, "");
	assert.equal(get(f.root).catalog.length, 0);
});

function catalogRepository(records) {
	const rows = new Map(records.map((row) => [row.id, structuredClone(row)]));
	const scopes = new Map();
	const scope = (id) => {
		if (scopes.has(id)) {
			return scopes.get(id);
		}
		const repo = memoryRepository(rows.get(id)?.identity);
		const base = repo.setConfig;
		repo.setConfig = async (identity, options) => {
			if (!rows.has(id)) {
				throw new Error("Library removed");
			}
			if (
				identity.publicKey &&
				[...rows.values()].some(
					(row) =>
						row.id !== id &&
						row.identity?.publicKey === identity.publicKey &&
						row.identity.serverUrl === identity.serverUrl,
				)
			) {
				throw new Error("already saved");
			}
			await base(identity, options);
			rows.get(id).identity = structuredClone(identity);
		};
		repo.close = () => {};
		scopes.set(id, repo);
		return repo;
	};
	return {
		initialized: true,
		unlocked: true,
		lock() {},
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
		deleteLibraries: async (ids) => {
			for (const id of ids) {
				await scope(id).reset();
				rows.delete(id);
			}
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
				privateKey: key.privateKey,
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
	const a = createLibraryClient(root, "lib-0");
	const b = createLibraryClient(root, "lib-1");
	t.after(a.dispose);
	t.after(b.dispose);
	return { root, a, b, engine, repository, keys };
}

test("failed setup writes no row, retries a fresh key and selects only a completed library", async (t) => {
	const keys = [];
	const f = await fixture(t, {
		api: {
			list: async () => ({ items: [], next: null }),
			registerAuthenticatedKey: async ({ publicKey }) => {
				keys.push(publicKey);
				if (keys.length === 1) {
					throw new Error("offline");
				}
			},
		},
	});
	const completed = [];
	const setup = createSetup(
		f.root,
		{},
		() => "lib-0",
		(id) => completed.push(id),
	);
	t.after(setup.dispose);
	setup.start();
	setup.settings.edit("libraryName", "Team");
	assert.equal(await setup.settings.create(), false);
	assert.equal((await f.repository.libraries()).length, 2);
	assert.equal(get(setup.settings).feedback.error, true);
	assert.match(
		get(setup.settings).feedback.text,
		/No recovery identity was retained/,
	);
	await setup.settings.create();
	await until(() => completed.length);
	assert.notEqual(keys[0], keys[1]);
	assert.equal(get(f.root).catalog.length, 3);
	assert.equal(
		(await f.repository.scope(completed[0]).getConfig()).publicKey,
		keys[1],
	);
	assert.equal(get(setup).open, false);
});
test("library selection is independent and vault unlock applies to all libraries; catalog renames retain identity", async (t) => {
	const f = await fixture(t);
	assert.equal(get(f.a).session.unlocked, true);
	assert.equal(get(f.b).session.unlocked, true);
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
		f.root.command("setup.open", {
			name: "PRIVATE",
			method: "create",
			serverUrl: "https://clip.example",
		}),
		/already used/,
	);
	f.a.select("lib-1");
	assert.equal(get(f.a).session.unlocked, true);
	assert.equal(get(f.b).libraryId, "lib-1");
});
test("switching tabs does not retarget a running upload; the owner has one upload lane", async (t) => {
	const gate = deferred();
	const seen = [];
	let active = 0;
	let max = 0;
	const f = await fixture(t, {
		upload: async (options) => {
			active++;
			max = Math.max(max, active);
			seen.push(options.credentials.privateKey);
			if (seen.length === 1) {
				await gate.promise;
			}
			active--;
			return { id: `media-${seen.length}` };
		},
	});
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
	const setupId = await f.root.command("setup.open", {
		name: "Team",
		method: "authorize",
		authorizerLibraryId: "lib-0",
	});
	const result = await f.root.command("identity.create", {
		setupId,
		epoch: 0,
		serverUrl: "https://clip.example",
		password: "new-password",
		authorizerLibraryId: "lib-0",
	});
	assert.equal(granted.privateKey, f.keys[0].privateKey);
	assert.notEqual(granted.publicKey, f.keys[0].publicKey);
	assert.equal(get(f.root).libraries[result.libraryId].session.unlocked, true);
	assert.equal(get(f.a).session.publicKey, f.keys[0].publicKey);
});

test("failed catalog removal restores the persisted library unlocked and leaves other libraries running", async (t) => {
	const f = await fixture(t);
	f.repository.deleteLibraries = async () => {
		throw new Error("disk failed");
	};
	await assert.rejects(
		f.root.command("libraries.forget", { libraryId: "lib-0" }),
		/disk failed/,
	);
	assert.equal(get(f.root).catalog.length, 2);
	assert.equal(get(f.a).session.configured, true);
	assert.equal(get(f.a).session.unlocked, true);
	assert.equal(get(f.b).session.unlocked, true);
	assert.equal(get(f.a).session.unlocked, true);
});
