import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	decryptOperation,
} from "../src/lib/protocol/chain.ts";
import { createPairingCrypto } from "../src/lib/services/pairing-crypto.ts";
import type {
	JoinedRoom,
	PairingRelay,
} from "../src/lib/services/pairing-relay.ts";
import { createChainStorage } from "../src/lib/storage/chain.ts";
import { createSessionStorage } from "../src/lib/storage/session.ts";
import { createChain } from "../src/lib/stores/chain.ts";
import { createPairing } from "../src/lib/stores/pairing.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { memoryStorage } from "./memory-database.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
class Relay implements PairingRelay {
	private step = 0;
	private message: Bytes | null = null;
	private removed = false;
	readonly submissions: number[] = [];
	beforeSubmit: ((step: number) => void | Promise<void>) | null = null;
	private snapshot(): JoinedRoom {
		return {
			v: 1,
			id: "K7MP",
			instance: "abcdefghijklmnopqrstuv",
			remaining_secs: 120,
			step: this.step,
			message: this.message,
			capability: "s".repeat(43),
		};
	}
	async create() {
		return this.snapshot();
	}
	async join(_id: string, message: Bytes) {
		this.step = 1;
		this.message = message;
		return this.snapshot();
	}
	async poll() {
		if (this.removed) {
			throw new Error("Room canceled");
		}
		return this.snapshot();
	}
	async submit(_room: JoinedRoom, step: number, message: Bytes) {
		await this.beforeSubmit?.(step);
		if (this.removed) {
			throw new Error("Room canceled");
		}
		assert.equal(step, this.step + 1);
		assert(step <= 5);
		this.submissions.push(step);
		this.step = step;
		this.message = message;
		return this.snapshot();
	}
	async cancel() {
		this.removed = true;
	}
}
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert(Date.now() < deadline, "Pairing did not reach its expected state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
async function fixture(t: test.TestContext) {
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
	const sender = createSession({
		persistence: createSessionStorage(memoryStorage().connect()),
		http: { registered: async () => false, register: async () => {} },
		verify: async (_identity, head) => head,
		download: () => {},
	});
	t.after(sender.dispose);
	const receiverPersistence = createSessionStorage(memoryStorage().connect());
	const receiver = createSession({
		persistence: receiverPersistence,
		verify: async (identity, minimum, signal) => {
			const cache = createChainStorage(
				identity.origin,
				bytesToHex(identity.library),
				new IDBFactory(),
			);
			const chain = createChain(
				{
					genesis: identity.genesis,
					signing: identity.signing,
					encryption: identity.encryption,
					minimum,
				},
				cache,
				{
					read: async () => ({ target: minimum, records: [], next: null }),
					append: async () => {
						assert.fail("Pairing must not publish blocks");
					},
				},
				signal,
			);
			try {
				const state = await chain.sync();
				return { sequence: state.sequence, hash: bytesToHex(state.head) };
			} finally {
				chain.dispose();
			}
		},
	});
	t.after(receiver.dispose);
	await sender.load();
	await sender.initialize("sender password");
	await sender.prepareCreation("https://example.test");
	await sender.downloadBackup();
	assert(
		await sender.create({ serverUrl: "https://example.test", otc: "invite" }),
	);
	await receiver.load();
	await receiver.initialize("receiver password");
	const context = get(sender).context;
	assert(context);
	const chain = createChain(
		{
			genesis: context.genesis,
			signing: context.key,
			encryption: context.encryption,
			minimum: context.head,
		},
		createChainStorage(
			context.serverUrl,
			bytesToHex(context.library),
			new IDBFactory(),
		),
		{
			read: async () => ({ target: context.head, records: [], next: null }),
			append: async () => {
				assert.fail("Pairing must not publish blocks");
			},
		},
		context.signal,
	);
	t.after(chain.dispose);
	const relay = new Relay();
	const sending = createPairing(sender, {
		chain: () => chain,
		relay: () => relay,
		pollMs: 1,
		crypto: createPairingCrypto,
	});
	const receiving = createPairing(receiver, {
		relay: () => relay,
		pollMs: 1,
		crypto: createPairingCrypto,
	});
	t.after(sending.dispose);
	t.after(receiving.dispose);
	async function pair() {
		const send = sending.send();
		await until(() => Boolean(get(sending).code));
		const receive = receiving.receive(
			get(sending).code,
			"https://example.test",
		);
		await until(
			() => get(sending).approval && Boolean(get(receiving).verificationCode),
		);
		assert.equal(
			get(sending).verificationCode,
			get(receiving).verificationCode,
		);
		sending.approve();
		return Promise.all([send, receive]);
	}
	return {
		sender,
		receiver,
		receiverPersistence,
		relay,
		sending,
		receiving,
		pair,
	};
}

test("PAKE transfers one shared identity, verifies it, and acknowledges durable storage without chain writes", async (t) => {
	const f = await fixture(t);
	f.relay.beforeSubmit = (step) => {
		if (step === 5) {
			assert(get(f.receiver).configured);
		}
	};
	assert.deepEqual(await f.pair(), [true, true]);
	assert.deepEqual(f.relay.submissions, [2, 3, 4, 5]);
	const a = get(f.sender).context;
	const b = get(f.receiver).context;
	assert(a && b);
	assert.deepEqual(a.key.publicKey, b.key.publicKey);
	const plaintext = new Uint8Array([1, 2, 3]);
	const record = await createRecord(
		{ library: a.library, sequence: 1, previous: a.library, effects: [] },
		a.key,
		a.encryption,
		plaintext,
	);
	assert.deepEqual(await decryptOperation(record, b.encryption), plaintext);
});

test("failed receiver persistence never acknowledges seed transfer", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.receiverPersistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.deepEqual(await f.pair(), [false, false]);
	assert.equal(f.relay.submissions.includes(5), false);
	assert.equal(get(f.receiver).context, null);
});

test("lost acknowledgment cannot retract an already connected receiver", async (t) => {
	const f = await fixture(t);
	f.relay.beforeSubmit = (step) => {
		if (step === 5) {
			f.receiving.cancel();
		}
	};
	const results = await f.pair();
	assert.equal(results[0], false);
	assert(get(f.receiver).configured);
	assert.match(get(f.sending).status, /may have been delivered/);
});
