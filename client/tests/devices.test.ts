import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createPersistence } from "../src/lib/persistence.ts";
import type { EncryptedBackup } from "../src/lib/protocol/backup.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { createRecord, verifyRecord } from "../src/lib/protocol/chain.ts";
import { reduceBlock } from "../src/lib/protocol/chain-state.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import {
	type ChainStore,
	type ChainView,
	stateCheckpoint,
} from "../src/lib/stores/chain.ts";
import { createDevices } from "../src/lib/stores/devices.ts";
import { createSession } from "../src/lib/stores/identity.ts";
import { initialSessionState, registerSession } from "./library-fixture.ts";
import { memoryStorage } from "./memory-database.ts";

async function fixture(t: test.TestContext) {
	const persistence = createPersistence(memoryStorage().connect());
	let recoveryFile: EncryptedBackup | null = null;
	const session = createSession({
		download: (file) => {
			recoveryFile = { bytes: file.bytes.slice(), password: file.password };
		},
		persistence,
		http: { registered: async () => false, register: async () => {} },
	});
	t.after(session.dispose);
	await session.load();
	await session.initialize("master password");
	await registerSession(session, {
		serverUrl: "https://example.test",
		otc: "invite",
	});
	const original = session.device();
	let server = await initialSessionState(session);
	const view = writable<ChainView>({
		live: server,
		syncing: false,
		mutating: false,
		error: "",
		storageError: "",
	});
	const chain: ChainStore = {
		subscribe: view.subscribe,
		async at() {
			throw new Error("Historical replay is not used by this fixture.");
		},
		async sync() {
			if (
				server.devices.get(bytesToHex(original.key.publicKey))?.revokedAt !==
				null
			) {
				throw new Error("Unauthorized");
			}
			return server;
		},
		async append(change) {
			assert.deepEqual(change.expected, stateCheckpoint(server));
			const record = await createRecord(
				{
					library: server.library,
					sequence: server.sequence + 1,
					previous: server.head,
					epoch: server.epoch,
					signer: original.key.publicKey,
					kind: change.kind,
					effects: change.effects,
				},
				original.key.privateCryptoKey,
			);
			server = reduceBlock(server, record);
			view.update((value) => ({ ...value, live: server }));
			return server;
		},
		dispose() {},
	};
	let outcome: "accepted" | "lost" | "rejected" = "accepted";
	const posts: Uint8Array<ArrayBuffer>[] = [];
	const probes: string[] = [];
	const devices = createDevices(
		session,
		chain,
		{
			async append(bytes) {
				posts.push(bytes.slice());
				if (outcome === "rejected") {
					throw new Error("Disconnected before acceptance");
				}
				const record = await verifyRecord(bytes);
				server = reduceBlock(server, record);
				if (outcome === "lost") {
					throw new Error("Lost response");
				}
				return {
					accepted: stateCheckpoint(server),
					head: stateCheckpoint(server),
				};
			},
		},
		get(session).signal,
		{
			admission: (device) => ({
				async registered() {
					probes.push(device.key.registrationKey);
					return (
						server.devices.get(bytesToHex(device.key.publicKey))?.revokedAt ===
						null
					);
				},
				dispose() {},
			}),
			verify: async (device, minimum) => {
				assert.equal(
					server.devices.get(bytesToHex(device.key.publicKey))?.revokedAt,
					null,
				);
				assert.deepEqual(minimum, stateCheckpoint(server));
				return server;
			},
		},
	);
	t.after(devices.dispose);
	return {
		session,
		devices,
		persistence,
		prepareRotation: () => {
			assert.ok(recoveryFile);
			return devices.prepareRotation(
				new Blob([recoveryFile.bytes]),
				recoveryFile.password,
			);
		},
		chain,
		original,
		posts,
		probes,
		current: () => server,
		outcome: (value: typeof outcome) => {
			outcome = value;
		},
	};
}

test("rotation uses its durable local plan, submits exact bytes and reconciles replacement admission after a lost response", async (t) => {
	const f = await fixture(t);
	assert.equal(await f.prepareRotation(), true);
	const plan = f.session.device().identity.rotation;
	assert.ok(plan);
	f.outcome("lost");
	assert.equal(await f.devices.submitRotation(), true);
	assert.equal(f.posts.length, 1);
	assert.deepEqual(f.posts[0], plan.record);
	assert.equal(f.session.identity().device.rotation, null);
	assert.deepEqual(f.session.identity().device.privateKey, plan.replacement);
	assert.equal(f.session.identity().device.epochs.length, 2);
	assert.equal(f.probes[0], f.session.identity().publicKey);
	assert.equal(f.probes.includes(f.original.key.registrationKey), false);
	assert.equal(
		Buffer.from(f.posts[0] ?? []).includes(Buffer.from(plan.secret)),
		false,
	);
});

test("a rejected append preserves the pending plan and retries the same transition", async (t) => {
	const f = await fixture(t);
	await f.prepareRotation();
	f.outcome("rejected");
	assert.equal(await f.devices.submitRotation(), true);
	assert.ok(f.session.device().identity.rotation);
	assert.match(get(f.devices).status, /not been accepted/);
	assert.equal(f.probes.at(-1), f.original.key.registrationKey);
	f.outcome("accepted");
	assert.equal(await f.devices.submitRotation(), true);
	assert.deepEqual(f.posts[0], f.posts[1]);
	assert.equal(f.session.identity().device.rotation, null);
});

test("a moved parent requires explicit reconstruction and a new local plan", async (t) => {
	const f = await fixture(t);
	await f.prepareRotation();
	const target = (await generatePrivateKey()).privateKey.public_key;
	await f.chain.append({
		expected: stateCheckpoint(f.current()),
		kind: "enroll",
		effects: [target],
	});
	assert.equal(await f.devices.submitRotation(), false);
	assert.equal(f.posts.length, 0);
	assert.match(get(f.devices).error, /new rotation/);
	assert.equal(await f.prepareRotation(), true);
	assert.equal(await f.devices.submitRotation(), true);
	assert.equal(f.posts.length, 1);
});

test("verified rotation remains recoverable when saving the final identity fails", async (t) => {
	const f = await fixture(t);
	await f.prepareRotation();
	const fail = t.mock.method(f.persistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.equal(await f.devices.submitRotation(), false);
	assert.match(get(f.devices).error, /Disk full/);
	assert.ok(f.session.device().identity.rotation);
	fail.mock.restore();
	assert.equal(await f.devices.reconcile(), true);
	assert.equal(f.session.identity().device.rotation, null);
	assert.equal(f.posts.length, 1);
});
