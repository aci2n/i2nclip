import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { exportRecovery, openRecovery } from "../src/lib/protocol/recovery.js";
import { createServiceEngine } from "../src/lib/service/engine.js";
import { createEncryptedRepository } from "../src/lib/service/repository.js";
import { deferred, tick } from "./helpers.js";
import { engineClient, until } from "./service-helpers.js";

function backend() {
	const records = new Map();
	return {
		records,
		ready: Promise.resolve(),
		get: async (id) => structuredClone(records.get(id)),
		async commit(entries, remove = [], clear = false) {
			const next = clear ? new Map() : new Map(records);
			for (const id of remove) {
				next.delete(id);
			}
			for (const [id, value] of entries) {
				next.set(id, structuredClone(value));
			}
			records.clear();
			for (const [id, value] of next) {
				records.set(id, value);
			}
		},
	};
}
async function fixture(t, options = {}, storage = backend()) {
	const repository = createEncryptedRepository(storage);
	const engine = createServiceEngine({
		repository,
		defaultServerUrl: "https://clip.example",
		api: { list: async () => ({ items: [], next: null }) },
		...options,
	});
	const first = engineClient(engine);
	const second = engineClient(engine);
	t.after(() => {
		first.dispose();
		second.dispose();
		engine.dispose();
	});
	await Promise.all([first.ready, second.ready]);
	return { repository, engine, first, second, storage };
}
async function addIdentity(
	f,
	name = "Private name",
	serverUrl = "https://private.example",
) {
	const key = await generatePrivateKey();
	await f.repository.putLibrary({
		id: name,
		name,
		identity: {
			serverUrl,
			privateKey: key.privateKey,
			publicKey: key.publicKey,
			identityGeneration: name,
		},
	});
	return key;
}

test("master password protects catalog, keys, job metadata and binary sources; password change rewrites only the wrapper", async () => {
	const storage = backend();
	const repository = createEncryptedRepository(storage);
	await repository.ready;
	await repository.initialize("master-password");
	const key = await generatePrivateKey();
	await repository.putLibrary({
		id: "lib",
		name: "Secret library",
		identity: {
			serverUrl: "https://secret.example",
			privateKey: key.privateKey,
			publicKey: key.publicKey,
		},
	});
	const source = {
		name: "private-file.txt",
		blob: new Blob(["private upload bytes"], { type: "text/plain" }),
		preview: { thumb: new Uint8Array([1, 2]), image: { width: 10 } },
	};
	await repository
		.scope("lib")
		.putJob(
			{ id: "job", name: source.name, tags: "private-tag", status: "failed" },
			source,
		);
	const saved = JSON.stringify([...storage.records]);
	for (const secret of [
		"Secret library",
		"secret.example",
		key.privateKey,
		"private-file.txt",
		"private-tag",
		"private upload bytes",
		"master-password",
	]) {
		assert(!saved.includes(secret));
	}
	const catalog = structuredClone(storage.records.get("catalog"));
	const bytes = structuredClone(storage.records.get("source:job"));
	await repository.changePassword("master-password", "new-master-password");
	assert.deepEqual(storage.records.get("catalog"), catalog);
	assert.deepEqual(storage.records.get("source:job"), bytes);
	repository.lock();
	await assert.rejects(repository.libraries(), /Unlock/);
	await assert.rejects(repository.unlock("master-password"), /Wrong password/);
	await repository.unlock("new-master-password");
	assert.equal(
		(await repository.libraries())[0].identity.privateKey,
		key.privateKey,
	);
	const recovered = await repository.scope("lib").getSource("job");
	assert.equal(await recovered.blob.text(), "private upload bytes");
	assert.deepEqual(recovered.preview.thumb, source.preview.thumb);
	assert.deepEqual(recovered.preview.image, source.preview.image);
});

test("all tabs unlock and lock together; owner restart hides every library until the master password is entered", async (t) => {
	const f = await fixture(t);
	assert.equal(get(f.first).vault.status, "uninitialized");
	await assert.rejects(
		f.first.command("libraries.add", { name: "Forbidden" }),
		/Unlock/,
	);
	await f.first.command("vault.initialize", { password: "master-password" });
	await addIdentity(f);
	await f.first.command("vault.lock");
	assert.equal(get(f.second).vault.status, "locked");
	assert.deepEqual(get(f.second).catalog, []);
	assert.deepEqual(get(f.second).libraries, {});
	await assert.rejects(
		f.second.command("vault.unlock", { password: "wrong-password" }),
		/Wrong password/,
	);
	await f.second.command("vault.unlock", { password: "master-password" });
	assert.equal(get(f.first).catalog.length, 1);
	assert.equal(get(f.first).libraries["Private name"].session.unlocked, true);
	assert(!JSON.stringify(get(f.first)).includes("privateKey"));
	f.engine.dispose();
	const restarted = await fixture(t, {}, f.storage);
	assert.equal(get(restarted.first).vault.status, "locked");
	assert.deepEqual(get(restarted.first).catalog, []);
	await restarted.first.command("vault.unlock", {
		password: "master-password",
	});
	assert.equal(get(restarted.second).catalog.length, 1);
});

test("lock interrupts an active upload and restored jobs require explicit retry", async (t) => {
	const pending = deferred();
	let calls = 0;
	let signal;
	const f = await fixture(t, {
		upload: (options) => {
			calls++;
			signal = options.signal;
			return pending.promise;
		},
	});
	await f.first.command("vault.initialize", { password: "master-password" });
	await addIdentity(f, "lib");
	await f.first.command("vault.lock");
	await f.first.command("vault.unlock", { password: "master-password" });
	await f.first.command("uploads.submit", {
		libraryId: "lib",
		sources: [{ name: "file", blob: new Blob(["content"]), preview: null }],
	});
	await until(() => calls === 1);
	await f.second.command("vault.lock");
	assert(signal.aborted);
	pending.resolve({ id: "late" });
	await tick();
	assert.deepEqual(get(f.first).libraries, {});
	await f.first.command("vault.unlock", { password: "master-password" });
	assert.equal(get(f.first).libraries.lib.uploads[0].status, "interrupted");
	assert.equal(calls, 1);
	assert.equal(
		await (
			await f.repository
				.scope("lib")
				.getSource(get(f.first).libraries.lib.uploads[0].id)
		).blob.text(),
		"content",
	);
});

test("recovery files use independent passwords, merge atomically across servers and skip duplicate identities", async (t) => {
	const f = await fixture(t);
	await f.first.command("vault.initialize", { password: "destination-master" });
	const a = await generatePrivateKey();
	const b = await generatePrivateKey();
	const libraries = [
		{
			name: "Same",
			serverUrl: "https://one.example",
			privateKey: a.privateKey,
		},
		{
			name: "Same",
			serverUrl: "https://two.example",
			privateKey: b.privateKey,
		},
	];
	const text = await exportRecovery(libraries, "recovery-password");
	for (const secret of [
		a.privateKey,
		"one.example",
		"Same",
		"recovery-password",
	]) {
		assert(!text.includes(secret));
	}
	await assert.rejects(
		openRecovery(text, "destination-master"),
		/Wrong password/,
	);
	const file = new Blob([text]);
	assert.deepEqual(
		await f.first.command("vault.previewRecovery", {
			file,
			password: "recovery-password",
		}),
		libraries.map(({ name, serverUrl }) => ({ name, serverUrl })),
	);
	const result = await f.first.command("vault.importRecovery", {
		file,
		password: "recovery-password",
	});
	assert.equal(result.imported.length, 2);
	assert.deepEqual(
		get(f.first).catalog.map((row) => row.name),
		["Same", "Same (2)"],
	);
	const again = await f.second.command("vault.importRecovery", {
		file,
		password: "recovery-password",
	});
	assert.equal(again.imported.length, 0);
	assert.equal(again.skipped, 2);
	await f.first.command("vault.changePassword", {
		currentPassword: "destination-master",
		password: "changed-master",
	});
	assert.equal(
		(await openRecovery(text, "recovery-password")).libraries.length,
		2,
	);
	const single = await f.first.command("vault.export", {
		libraryId: result.imported[0],
		password: "export-password",
	});
	assert.equal(
		(await openRecovery(await single.text(), "export-password")).scope,
		"library",
	);
});

test("failed commits preserve the old master password and cannot acknowledge source acceptance", async () => {
	const storage = backend();
	const repository = createEncryptedRepository(storage);
	await repository.ready;
	await repository.initialize("master-password");
	const commit = storage.commit;
	storage.commit = async () => {
		throw new Error("disk full");
	};
	await assert.rejects(
		repository.changePassword("master-password", "changed-password"),
		/disk full/,
	);
	await assert.rejects(
		repository
			.scope("lib")
			.putJob({ id: "job" }, { blob: new Blob(["source"]) }),
		/disk full/,
	);
	assert.deepEqual(await repository.jobs(), []);
	assert(!storage.records.has("source:job"));
	storage.commit = commit;
	repository.lock();
	await repository.unlock("master-password");
});

test("lock during unlock prevents partial activation; corrupt identities leave every tab locked", async (t) => {
	const f = await fixture(t);
	await f.first.command("vault.initialize", { password: "master-password" });
	await addIdentity(f, "good");
	await addIdentity(f, "bad");
	const config = await f.repository.scope("bad").getConfig();
	config.publicKey = "wrong";
	await f.repository.scope("bad").setConfig(config);
	await f.first.command("vault.lock");
	await assert.rejects(
		f.first.command("vault.unlock", { password: "master-password" }),
		/Invalid saved identity/,
	);
	assert.equal(get(f.second).vault.status, "locked");
	assert.deepEqual(get(f.second).libraries, {});
	const opened = deferred();
	const release = deferred();
	const unlock = f.repository.unlock;
	f.repository.unlock = async (...args) => {
		opened.resolve();
		await release.promise;
		return unlock(...args);
	};
	const unlocking = f.first.command("vault.unlock", {
		password: "master-password",
	});
	const rejected = assert.rejects(unlocking, /Vault context ended/);
	await opened.promise;
	await f.second.command("vault.lock");
	release.resolve();
	await rejected;
	assert.equal(get(f.first).vault.status, "locked");
	assert.deepEqual(get(f.first).catalog, []);
});

test("encrypted sources are bound to their identifier and cannot be substituted", async () => {
	const storage = backend();
	const repository = createEncryptedRepository(storage);
	await repository.ready;
	await repository.initialize("master-password");
	await repository
		.scope("lib")
		.putJob({ id: "one" }, { blob: new Blob(["first"]) });
	await repository
		.scope("lib")
		.putJob({ id: "two" }, { blob: new Blob(["second"]) });
	storage.records.set("source:two", storage.records.get("source:one"));
	await assert.rejects(repository.scope("lib").getSource("two"));
});

test("locked context uploads stay transient until unlock and destination selection", async (t) => {
	const opened = [];
	const f = await fixture(t, {
		platform: {
			openUpload: (...args) => opened.push(args),
			fetchMedia: async () => new Response("bytes"),
		},
	});
	await f.first.command("vault.initialize", { password: "master-password" });
	await addIdentity(f, "lib");
	await f.first.command("vault.lock");
	const before = JSON.stringify([...f.storage.records]);
	const id = await f.engine.contextUpload(
		{ srcUrl: "https://secret.example/file" },
		true,
	);
	assert.equal(JSON.stringify([...f.storage.records]), before);
	assert.equal(opened[0][0], id);
	await f.first.command("vault.unlock", { password: "master-password" });
	assert.equal(get(f.first).transientUploads[0].id, id);
	await f.first.command("vault.contextUpload", { id, libraryId: "lib" });
	assert.equal(get(f.first).transientUploads.length, 0);
	assert.equal(get(f.first).libraries.lib.uploads[0].id, id);
});

test("lock invalidates queued unlock commands instead of reopening the vault", async (t) => {
	const f = await fixture(t);
	await f.first.command("vault.initialize", { password: "master-password" });
	const entered = deferred();
	const release = deferred();
	f.repository.changePassword = async () => {
		entered.resolve();
		await release.promise;
	};
	const changing = f.first.command("vault.changePassword", {
		currentPassword: "master-password",
		password: "changed-password",
	});
	const canceledChange = assert.rejects(changing, /Vault context ended/);
	await entered.promise;
	const unlocking = f.second.command("vault.unlock", {
		password: "master-password",
	});
	const canceledUnlock = assert.rejects(unlocking, /Vault context ended/);
	await tick();
	await f.first.command("vault.lock");
	release.resolve();
	await Promise.all([canceledChange, canceledUnlock]);
	assert.equal(get(f.second).vault.status, "locked");
	assert.equal(f.repository.unlocked, false);
});

test("source acceptance waits for one atomic encrypted catalog and source commit", async () => {
	const storage = backend();
	const repository = createEncryptedRepository(storage);
	await repository.ready;
	await repository.initialize("master-password");
	const committed = deferred();
	const release = deferred();
	const commit = storage.commit;
	let entries;
	let acknowledged = false;
	storage.commit = async (...args) => {
		entries = args[0];
		committed.resolve();
		await release.promise;
		return commit(...args);
	};
	const saving = repository
		.scope("lib")
		.putJob({ id: "job", name: "secret-name" }, { blob: new Blob(["source"]) })
		.then(() => {
			acknowledged = true;
		});
	await committed.promise;
	assert.equal(acknowledged, false);
	assert.deepEqual(await repository.jobs(), []);
	assert.deepEqual(
		entries.map(([id]) => id),
		["catalog", "source:job"],
	);
	assert(entries[1][1].ct instanceof Uint8Array);
	release.resolve();
	await saving;
	assert.equal(acknowledged, true);
	assert.equal((await repository.jobs()).length, 1);
});

test("recovery import fails atomically and oversized files are rejected before reading", async (t) => {
	const f = await fixture(t);
	await f.first.command("vault.initialize", { password: "master-password" });
	const key = await generatePrivateKey();
	const file = new Blob([
		await exportRecovery(
			[
				{
					name: "Personal",
					serverUrl: "https://clip.example",
					privateKey: key.privateKey,
				},
			],
			"recovery-password",
			"library",
		),
	]);
	const before = await f.repository.libraries();
	const commit = f.storage.commit;
	f.storage.commit = async () => {
		throw new Error("disk full");
	};
	await assert.rejects(
		f.first.command("vault.importRecovery", {
			file,
			password: "recovery-password",
		}),
		/disk full/,
	);
	assert.deepEqual(await f.repository.libraries(), before);
	assert.equal(get(f.first).catalog.length, 0);
	f.storage.commit = commit;
	await assert.rejects(
		f.first.command("vault.previewRecovery", {
			file: new Blob([new Uint8Array(1024 * 1024 + 1)]),
			password: "recovery-password",
		}),
		/Invalid recovery file/,
	);
	const result = await f.first.command("vault.importRecovery", {
		file,
		password: "recovery-password",
	});
	assert.equal(get(f.first).catalog[0].name, "Personal");
	assert.equal(result.imported.length, 1);
	assert.equal(get(f.first).setups.length, 0);
});

test("locking clears unsubmitted setup names, servers and invitation drafts", async (t) => {
	const { createSetup } = await import("../src/lib/stores/setup.js");
	const f = await fixture(t);
	await f.first.command("vault.initialize", { password: "master-password" });
	const setup = createSetup(
		f.first,
		{},
		() => get(f.first).setups[0]?.id,
		() => {},
	);
	t.after(setup.dispose);
	setup.start();
	setup.settings.edit("libraryName", "Private draft");
	setup.settings.edit("server", "https://private.example");
	setup.settings.edit("otc", "private-invitation");
	await f.second.command("vault.lock");
	assert.equal(get(setup).open, false);
	assert.equal(get(setup.settings).libraryName, "");
	assert.equal(get(setup.settings).server, "");
	assert.equal(get(setup.settings).otc, "");
});

test("recovery review keeps secrets local and import completion survives its own setup view disposal", async (t) => {
	const { createRecoveryImport } = await import(
		"../src/lib/stores/recovery-import.js"
	);
	const { createVault } = await import("../src/lib/stores/vault.js");
	const f = await fixture(t);
	await f.first.command("vault.initialize", { password: "master-password" });
	const vault = createVault(f.first, {});
	t.after(vault.dispose);
	const key = await generatePrivateKey();
	const file = new Blob([
		await exportRecovery(
			[
				{
					name: "Personal",
					serverUrl: "https://clip.example",
					privateKey: key.privateKey,
				},
			],
			"recovery-password",
			"library",
		),
	]);
	let completed;
	const form = createRecoveryImport(vault, (id) => {
		completed = id;
	});
	t.after(form.dispose);
	const unsubscribe = f.first.subscribe((value) => {
		if (value.catalog.length) {
			form.dispose();
		}
	});
	t.after(unsubscribe);
	form.edit("files", [file]);
	form.edit("password", "recovery-password");
	await form.review();
	assert.equal(get(form).password, "");
	assert.equal(get(form).preview[0].name, "Personal");
	await form.restore();
	assert.equal(completed, get(f.first).catalog[0].id);
	assert.deepEqual(get(form).preview, []);
});
