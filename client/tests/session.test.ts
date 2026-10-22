import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { HttpError } from "../src/lib/services/library-api.ts";
import { createChainStorage } from "../src/lib/storage/chain.ts";
import { createSessionStorage } from "../src/lib/storage/session.ts";
import {
	createSession,
	type LibraryBackup,
} from "../src/lib/stores/session.ts";
import { memoryStorage } from "./memory-database.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
function fixture(t: test.TestContext) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
	Object.defineProperty(globalThis, "indexedDB", {
		value: new IDBFactory(),
		configurable: true,
	});
	t.after(() => {
		if (descriptor) {
			Object.defineProperty(globalThis, "indexedDB", descriptor);
		} else {
			Reflect.deleteProperty(globalThis, "indexedDB");
		}
	});
	const database = memoryStorage();
	const persistence = createSessionStorage(database.connect());
	let registered = false;
	let posts = 0;
	let backup: LibraryBackup | undefined;
	const verify = async (
		_identity: unknown,
		minimum: { sequence: number; hash: string },
	) => minimum;
	const http = {
		registered: async () => registered,
		register: async () => {
			posts++;
			assert(get(session).prepared);
			assert(
				(await persistence.read(new AbortController().signal))
					?.registrationPending,
			);
			registered = true;
		},
	};
	const options = {
		persistence,
		http,
		verify,
		download: (file: LibraryBackup) => {
			backup = { bytes: file.bytes.slice(), password: file.password };
		},
	};
	const session = createSession(options);
	t.after(session.dispose);
	return {
		session,
		persistence,
		database,
		http,
		verify,
		backup: () => {
			assert(backup);
			return backup;
		},
		posts: () => posts,
	};
}
async function initialize(f: ReturnType<typeof fixture>) {
	await f.session.load();
	assert(await f.session.initialize("local password"));
	assert(await f.session.prepareCreation("https://example.test"));
}
async function register(f: ReturnType<typeof fixture>) {
	assert(await f.session.downloadBackup());
	assert(
		await f.session.create({
			serverUrl: "https://example.test",
			otc: "invite",
		}),
	);
}

test("creation persists credentials before publication and gates on credential backup", async (t) => {
	const f = fixture(t);
	await initialize(f);
	assert.equal(
		await f.session.create({
			serverUrl: "https://example.test",
			otc: "invite",
		}),
		false,
	);
	assert.equal(f.posts(), 0);
	await register(f);
	assert(get(f.session).configured);
	assert.equal(f.posts(), 1);
	const saved = await f.persistence.read(new AbortController().signal);
	assert(saved);
	assert.equal(saved.registrationPending, false);
	assert.equal("seed" in saved, false);
	assert.equal(get(f.session).backup, null);
});

test("backup restore recovers the existing identity without registration or chain mutation", async (t) => {
	const f = fixture(t);
	await initialize(f);
	await register(f);
	const file = f.backup();
	const before = get(f.session).context;
	assert(before);
	const restored = createSession({
		persistence: createSessionStorage(memoryStorage().connect()),
		http: {
			registered: async () => {
				assert.fail("Restore must independently verify history");
			},
			register: async () => {
				assert.fail("Restore must not register");
			},
		},
		verify: f.verify,
	});
	t.after(restored.dispose);
	await restored.load();
	await restored.initialize("another password");
	assert(await restored.restore(new Blob([file.bytes]), file.password));
	assert.deepEqual(get(restored).context?.key.publicKey, before.key.publicKey);
	assert.deepEqual(get(restored).context?.library, before.library);
	assert.equal(f.posts(), 1);
});

test("accepted registration with a lost response resumes exact credentials without spending a new invitation", async (t) => {
	const f = fixture(t);
	await initialize(f);
	await f.session.downloadBackup();
	const registerMethod = f.http.register;
	t.mock.method(f.http, "register", async () => {
		await registerMethod();
		throw new Error("Lost response");
	});
	assert.equal(
		await f.session.create({
			serverUrl: "https://example.test",
			otc: "invite",
		}),
		false,
	);
	assert(get(f.session).prepared);
	assert.equal(f.posts(), 1);
	assert(
		await f.session.create({
			serverUrl: "https://example.test",
			otc: "another invite",
		}),
	);
	assert.equal(f.posts(), 1);
	assert(get(f.session).configured);
});

test("password changes preserve the live context and remembered unlock is removed on Lock", async (t) => {
	const f = fixture(t);
	await initialize(f);
	await register(f);
	const context = get(f.session).context;
	assert(context);
	assert(
		await f.session.changePassword("local password", "new local password"),
	);
	assert.equal(get(f.session).context, context);
	assert.equal(context.signal.aborted, false);
	await f.session.lock();
	assert(context.signal.aborted);
	assert.equal(await f.session.unlock("local password"), false);
	assert(await f.session.unlock("new local password", true));
	const saved = await f.persistence.read(new AbortController().signal);
	assert(saved?.key);
	assert(await f.session.lock());
	assert.equal(
		(await f.persistence.read(new AbortController().signal))?.key,
		undefined,
	);
});

test("failed import verification leaves sealed credentials for an explicit retry, never an active context", async (t) => {
	const f = fixture(t);
	await initialize(f);
	await register(f);
	const backup = f.backup();
	let fail = true;
	const restored = createSession({
		persistence: createSessionStorage(memoryStorage().connect()),
		verify: async (_identity, head) => {
			if (fail) {
				throw new Error("Invalid history");
			}
			return head;
		},
	});
	t.after(restored.dispose);
	await restored.load();
	await restored.initialize("another password");
	assert.equal(
		await restored.restore(new Blob([backup.bytes]), backup.password),
		false,
	);
	assert.equal(get(restored).context, null);
	assert(get(restored).pendingConnection);
	fail = false;
	assert(await restored.retryConnection());
	assert(get(restored).configured);
});

test("failed preparation persistence and failed backup downloads never register", async (t) => {
	const f = fixture(t);
	await f.session.load();
	await f.session.initialize("local password");
	const save = t.mock.method(f.persistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.equal(await f.session.prepareCreation("https://example.test"), false);
	assert.equal(get(f.session).prepared, false);
	assert.equal(f.posts(), 0);
	save.mock.restore();
	assert(await f.session.prepareCreation("https://example.test"));
	const backup = get(f.session).backup;
	assert(backup);
	// A failed download must retain the artifact and keep the creation gate closed.
	const failing = createSession({
		persistence: createSessionStorage(memoryStorage().connect()),
		download: () => {
			throw new Error("Download blocked");
		},
		http: f.http,
		verify: f.verify,
	});
	t.after(failing.dispose);
	await failing.load();
	await failing.initialize("password");
	assert(await failing.prepareCreation("https://example.test"));
	const original = get(failing).backup;
	assert.equal(await failing.downloadBackup(), false);
	assert.equal(get(failing).backup, original);
	assert.equal(get(failing).backupDownloaded, false);
	assert.equal(
		await failing.create({ serverUrl: "https://example.test", otc: "invite" }),
		false,
	);
	assert.equal(f.posts(), 0);
});

test("independent tabs retain loaded credentials when another tab locks or forgets", async (t) => {
	const f = fixture(t);
	await initialize(f);
	await register(f);
	const second = createSession({
		persistence: createSessionStorage(f.database.connect()),
		http: f.http,
		verify: f.verify,
	});
	t.after(second.dispose);
	await second.load();
	assert(await second.unlock("local password"));
	const context = get(second).context;
	assert(context);
	await f.session.lock();
	assert.equal(get(second).context, context);
	assert.equal(context.signal.aborted, false);
	assert(await f.session.unlock("local password"));
	assert(await f.session.forget());
	assert.equal(get(second).context, context);
	assert.equal(context.signal.aborted, false);
	assert(await second.prepareBackup());
});

test("failed credential removal preserves cached rollback protection", async (t) => {
	const f = fixture(t);
	await initialize(f);
	await register(f);
	const context = get(f.session).context;
	assert(context);
	const cache = createChainStorage(
		context.serverUrl,
		bytesToHex(context.library),
	);
	t.after(cache.dispose);
	const checkpoint = { sequence: 2, hash: "ab".repeat(32) };
	await cache.ensureHead(checkpoint, new AbortController().signal);
	const save = t.mock.method(f.persistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.equal(await f.session.forget(), false);
	assert.deepEqual(await cache.head(new AbortController().signal), checkpoint);
	save.mock.restore();
	assert(await f.session.unlock("local password"));
	assert(await f.session.forget());
	assert.equal(await cache.head(new AbortController().signal), null);
});

test("a pre-registration backup resumes creation only after an explicit unknown-library response", async (t) => {
	const f = fixture(t);
	await initialize(f);
	await f.session.downloadBackup();
	const backup = f.backup();
	const restored = createSession({
		persistence: createSessionStorage(memoryStorage().connect()),
		download: () => {},
		http: { registered: async () => false, register: async () => {} },
		verify: async () => {
			throw new HttpError(401);
		},
	});
	t.after(restored.dispose);
	await restored.load();
	await restored.initialize("local password");
	assert(await restored.restore(new Blob([backup.bytes]), backup.password));
	assert(get(restored).prepared);
	assert.equal(get(restored).context, null);
	assert.equal(get(restored).backupDownloaded, false);
	assert.deepEqual(get(restored).backup?.bytes instanceof Uint8Array, true);
});
