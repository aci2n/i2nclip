import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import { createChainApi } from "../src/lib/chain-api.ts";
import { createChainStorage } from "../src/lib/chain-storage.ts";
import { createPairingCrypto } from "../src/lib/pairing/crypto.ts";
import type {
	JoinedRoom,
	PairingRelay,
	Room,
} from "../src/lib/pairing/service.ts";
import { createPersistence } from "../src/lib/persistence.ts";
import { b64urlToBytes, bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	type VerifiedBlock,
	verifyRecord,
} from "../src/lib/protocol/chain.ts";
import {
	type ChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { pairedDevice } from "../src/lib/protocol/pairing-device.ts";
import { createChain } from "../src/lib/stores/chain.ts";
import { createChainPairing } from "../src/lib/stores/chain-pairing.ts";
import { createSession } from "../src/lib/stores/identity.ts";
import {
	initialSessionState,
	registerSession,
	sessionEnrollment,
} from "./library-fixture.ts";
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
	async submit(_room: JoinedRoom, step: number, message: Bytes): Promise<Room> {
		await this.beforeSubmit?.(step);
		if (this.removed) {
			throw new Error("Room canceled");
		}
		assert.equal(step, this.step + 1);
		this.submissions.push(step);
		this.step = step;
		this.message = message;
		return this.snapshot();
	}
	async cancel() {
		this.removed = true;
	}
}
class Server {
	readonly records: VerifiedBlock[] = [];
	state: ChainState;
	constructor(state: ChainState) {
		this.state = state;
	}
	readonly fetch = this.request.bind(this);
	async append(bytes: Bytes) {
		const record = await verifyRecord(bytes);
		this.state = reduceBlock(this.state, record);
		this.records.push(record);
		return record;
	}
	private async request(input: string | URL | Request, options?: RequestInit) {
		const url = new URL(String(input));
		const header = new Headers(options?.headers).get("Authorization") ?? "";
		const publicKey = b64urlToBytes(
			header.replace("Bearer ", "").split(".")[0],
		);
		const active =
			this.state.devices.get(bytesToHex(publicKey))?.revokedAt === null;
		if (url.pathname === "/api/ping") {
			return new Response(null, { status: active ? 204 : 401 });
		}
		if (!active) {
			return new Response(null, { status: 401 });
		}
		assert.equal(url.pathname, "/api/blocks");
		if (options?.method === "POST") {
			const record = await verifyRecord(
				new Uint8Array(options.body as Uint8Array),
			);
			if (bytesToHex(record.body.previous) !== bytesToHex(this.state.head)) {
				return new Response(null, { status: 409 });
			}
			await this.append(record.bytes);
			return new Response(
				encode([
					record.hash,
					record.body.sequence,
					this.state.head,
					this.state.sequence,
				]),
			);
		}
		const after = url.searchParams.get("after");
		const index =
			after === bytesToHex(this.state.library)
				? -1
				: this.records.findIndex((r) => bytesToHex(r.hash) === after);
		return new Response(
			encode([
				this.state.head,
				this.state.sequence,
				this.records.slice(index + 1).map((record) => record.bytes),
				null,
			]),
		);
	}
}
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Pairing did not reach expected state");
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
		persistence: createPersistence(memoryStorage().connect()),
		download: () => {},
		http: { registered: async () => false, register: async () => {} },
	});
	const receiverPersistence = createPersistence(memoryStorage().connect());
	const receiver = createSession({ persistence: receiverPersistence });
	t.after(sender.dispose);
	t.after(receiver.dispose);
	await sender.load();
	await sender.initialize("sender password");
	await registerSession(sender, {
		serverUrl: "https://example.test",
		otc: "invite",
	});
	await receiver.load();
	await receiver.initialize("receiver password");
	const original = sender.device();
	const server = new Server(await initialSessionState(sender));
	server.records.push(await sessionEnrollment(sender));
	t.mock.method(globalThis, "fetch", server.fetch);
	const controller = new AbortController();
	t.after(() => controller.abort());
	const api = createChainApi(
		original.identity.serverUrl,
		original.key,
		controller.signal,
	);
	t.after(api.dispose);
	const cache = createChainStorage(
		original.identity.serverUrl,
		bytesToHex(original.identity.library),
		new IDBFactory(),
	);
	t.after(cache.dispose);
	const chain = createChain(
		{
			genesis: original.identity.genesis,
			publicKey: original.key.publicKey,
			signingKey: original.key.privateCryptoKey,
			secrets: new Map(original.identity.epochs),
			minimum: original.identity.head,
		},
		cache,
		api,
		controller.signal,
	);
	t.after(chain.dispose);
	const relay = new Relay();
	let bundle: unknown;
	const senderPairing = createChainPairing(sender, {
		chain: () => chain,
		relay: () => relay,
		pollMs: 1,
		crypto: () => {
			const crypto = createPairingCrypto();
			return {
				...crypto,
				transfer: (args) => {
					bundle = args.value;
					return crypto.transfer(args);
				},
			};
		},
	});
	const receiverPairing = createChainPairing(receiver, {
		relay: () => relay,
		pollMs: 1,
		crypto: createPairingCrypto,
	});
	t.after(senderPairing.dispose);
	t.after(receiverPairing.dispose);
	async function pair() {
		const send = senderPairing.send();
		await until(() => Boolean(get(senderPairing).code));
		const receive = receiverPairing.receive(
			get(senderPairing).code,
			"https://example.test",
		);
		await until(() => get(senderPairing).approval);
		assert.equal(
			get(senderPairing).verificationCode,
			get(receiverPairing).verificationCode,
		);
		senderPairing.approve();
		return Promise.all([send, receive]);
	}
	return {
		sender,
		receiver,
		receiverPersistence,
		server,
		chain,
		relay,
		senderPairing,
		receiverPairing,
		pair,
		bundle: () => bundle,
	};
}

test("pairing enrolls a fresh receiver only after durable preparation and verifies activation", async (t) => {
	const f = await fixture(t);
	f.relay.beforeSubmit = (step) => {
		if (step === 5) {
			assert.equal(f.receiver.device().identity.phase, "pairing");
			assert.equal(get(f.receiver).context, null);
			assert.equal(f.server.records.length, 1);
		}
	};
	assert.deepEqual(await f.pair(), [true, true]);
	assert.notEqual(
		f.sender.identity().publicKey,
		f.receiver.identity().publicKey,
	);
	assert.deepEqual(
		f.sender.identity().device.epochs,
		f.receiver.identity().device.epochs,
	);
	assert.equal(f.server.records.length, 2);
	assert.equal(
		f.receiver.identity().device.head.hash,
		bytesToHex(f.server.records[1].hash),
	);
	const bundle = f.bundle();
	assert.ok(Array.isArray(bundle));
	assert.equal(bundle.length, 7);
	assert.equal(
		Buffer.from(encode(bundle)).includes(
			Buffer.from(f.sender.identity().privateKey.seed),
		),
		false,
	);
	assert.deepEqual(f.relay.submissions, [2, 3, 4, 5, 6, 7]);
});

test("failed receiver persistence never acknowledges preparation or publishes enrollment", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.receiverPersistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.deepEqual(await f.pair(), [false, false]);
	assert.equal(f.server.records.length, 1);
	assert.equal(f.relay.submissions.includes(5), false);
	assert.equal(get(f.receiver).context, null);
});

test("lost completion preserves pending credentials that can independently activate", async (t) => {
	const f = await fixture(t);
	f.relay.beforeSubmit = (step) => {
		if (step === 6) {
			f.receiverPairing.cancel();
		}
	};
	assert.deepEqual(await f.pair(), [false, false]);
	assert.equal(f.server.records.length, 2);
	assert.equal(f.receiver.device().identity.phase, "pairing");
	assert.match(get(f.senderPairing).status, /Enrollment may have committed/);
	assert.equal(await f.receiver.activatePairing(), true);
	assert.notEqual(
		f.sender.identity().publicKey,
		f.receiver.identity().publicKey,
	);
});

test("head changes after proposal require a new pairing attempt without silent rebase", async (t) => {
	const f = await fixture(t);
	const target = (await generatePrivateKey()).privateKey.public_key;
	f.relay.beforeSubmit = async (step) => {
		if (step === 5) {
			const original = f.sender.identity();
			const state = f.server.state;
			const competing = await createRecord(
				{
					library: state.library,
					sequence: state.sequence + 1,
					previous: state.head,
					epoch: 1,
					signer: original.key.publicKey,
					kind: "enroll",
					effects: [target],
				},
				original.key.privateCryptoKey,
			);
			await f.server.append(competing.bytes);
		}
	};
	assert.deepEqual(await f.pair(), [false, false]);
	assert.equal(f.server.records.length, 2);
	assert.deepEqual(f.server.records[1].body.effects[0], target);
	assert.equal(f.receiver.device().identity.phase, "pairing");
	assert.equal(get(f.receiver).context, null);
});

test("receiver rejects bundles with another origin, parent, epoch history, or target", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.pair(), [true, true]);
	const original = f.bundle();
	assert.ok(Array.isArray(original));
	const privateKey = f.receiver.identity().privateKey;
	for (const [index, value] of [
		[1, "https://other.test"],
		[3, new Uint8Array(32)],
		[4, [[2, new Uint8Array(32)]]],
		[5, [2, new Uint8Array(32)]],
	] as const) {
		const changed = structuredClone(original);
		changed[index] = value;
		await assert.rejects(
			pairedDevice(
				changed,
				privateKey,
				f.receiver.identity().device.encryption,
				"https://example.test",
			),
		);
	}
	await assert.rejects(
		pairedDevice(
			original,
			f.sender.identity().privateKey,
			f.sender.identity().device.encryption,
			"https://example.test",
		),
	);
});
