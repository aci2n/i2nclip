import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import {
	createPersistence,
	type LocalStorage,
} from "../src/lib/persistence.ts";
import type { SessionChannel } from "../src/lib/session-sharing.ts";
import {
	createSession,
	type Session,
	type SessionState,
} from "../src/lib/stores/session.ts";
import { deferred, tick } from "./helpers.ts";
import { captureLogs } from "./log-capture.ts";

const password = "master-password";
function waitState(
	t: test.TestContext,
	session: Session,
	predicate: (value: SessionState) => boolean,
) {
	const done = deferred();
	const timeoutError = new Error("Session did not reach expected state");
	const timer = setTimeout(() => done.reject(timeoutError), 5000);
	const unsubscribe = session.subscribe((value) => {
		if (predicate(value)) {
			done.resolve();
		}
	});
	const clean = () => {
		clearTimeout(timer);
		unsubscribe();
	};
	t.after(clean);
	return done.promise.finally(clean);
}
function fixture(t: test.TestContext) {
	const values = new Map<string, string>();
	const clients: { local: LocalStorage; events: EventTarget }[] = [];
	const channels = new Set<EventTarget>();
	function memoryChannel(): SessionChannel {
		const target = new EventTarget();
		channels.add(target);
		return {
			addEventListener: target.addEventListener.bind(target),
			removeEventListener: target.removeEventListener.bind(target),
			postMessage(data) {
				for (const recipient of channels) {
					if (recipient !== target) {
						const copy = structuredClone(data);
						queueMicrotask(() => {
							if (channels.has(recipient)) {
								recipient.dispatchEvent(
									new MessageEvent("message", { data: copy }),
								);
							}
						});
					}
				}
			},
			close() {
				channels.delete(target);
			},
		};
	}
	function tab(factory: () => SessionChannel | null = memoryChannel) {
		const events = new EventTarget();
		const local: LocalStorage = {
			getItem: (key) => values.get(key) ?? null,
			setItem(key, value) {
				values.set(key, value);
				notify(key);
			},
			removeItem(key) {
				values.delete(key);
				notify(key);
			},
		};
		function notify(key: string) {
			for (const other of clients) {
				if (other.local !== local) {
					queueMicrotask(() =>
						other.events.dispatchEvent(
							Object.assign(new Event("storage"), {
								key,
								storageArea: other.local,
							}),
						),
					);
				}
			}
		}
		clients.push({ local, events });
		const persistence = createPersistence(local);
		const session = createSession({
			persistence,
			events,
			channel: factory,
			http: { registerKey: async () => {}, isKeyRegistered: async () => true },
		});
		t.after(session.dispose);
		return { session, persistence, local };
	}
	return { tab, values };
}
async function configured(t: test.TestContext) {
	const f = fixture(t);
	const first = f.tab();
	assert.equal(await first.session.initialize(password), true);
	assert.equal(
		await first.session.create({
			serverUrl: "https://clip.example",
			otc: "invite",
		}),
		true,
	);
	return { ...f, first };
}
test("inherited access includes management operations and recipients become donors", async (t) => {
	const logs = captureLogs(t);
	const f = await configured(t);
	const second = f.tab();
	await waitState(t, second.session, (s) => s.configured);
	assert.deepEqual(
		second.session.identity().privateKey,
		f.first.session.identity().privateKey,
	);
	f.first.session.dispose();
	const third = f.tab();
	await waitState(t, third.session, (s) => s.configured);
	assert.deepEqual(
		third.session.identity().privateKey,
		second.session.identity().privateKey,
	);
	assert.equal(await third.session.forget(), true);
	await waitState(t, second.session, (s) => s.unlocked && !s.configured);
	assert.equal(get(second.session).context, null);
	for (const event of ["requested", "grant-sent", "grant-received"]) {
		assert(
			logs.some(
				(entry) => entry.event === `[i2nclip] session-sharing.${event}`,
			),
		);
	}
	assert(
		logs.some(
			(entry) => entry.event === "[i2nclip] session.shared-unlock-completed",
		),
	);
	const output = JSON.stringify(logs);
	assert(!output.includes(password));
	for (const record of f.values.values()) {
		assert(!output.includes(record));
	}
});
test("closing all donors leaves only ciphertext and requires a fresh password", async (t) => {
	const f = await configured(t);
	const second = f.tab();
	await waitState(t, second.session, (s) => s.configured);
	f.first.session.dispose();
	second.session.dispose();
	const last = f.tab();
	await waitState(t, last.session, (s) => !s.checking);
	assert.equal(get(last.session).status, "locked");
	assert.equal(f.values.size, 1);
	assert.equal(await last.session.unlock(password), true);
});
test("password changes replace all contexts and other tabs reconnect automatically", async (t) => {
	const f = await configured(t);
	const second = f.tab();
	await waitState(t, second.session, (s) => s.configured);
	const before = get(second.session).signal;
	const local = get(f.first.session).signal;
	assert.equal(
		await f.first.session.changePassword(password, "changed-password"),
		true,
	);
	assert.equal(local.aborted, true);
	await waitState(
		t,
		second.session,
		(s) => s.configured && s.signal !== before,
	);
	assert.equal(before.aborted, true);
	assert.equal(
		await second.session.changePassword(password, "other-password"),
		false,
	);
	assert.equal(
		await second.session.changePassword("changed-password", "other-password"),
		true,
	);
});
test("a locked tab inherits access when another tab later unlocks", async (t) => {
	const f = await configured(t);
	f.first.session.dispose();
	const waiting = f.tab();
	await waitState(t, waiting.session, (s) => !s.checking);
	const unlocking = f.tab();
	assert.equal(await unlocking.session.unlock(password), true);
	await waitState(t, waiting.session, (s) => s.configured);
});
test("empty identity unlock is shared, and reset clears access in every tab", async (t) => {
	const f = fixture(t);
	const first = f.tab();
	await first.session.initialize(password);
	const second = f.tab();
	await waitState(t, second.session, (s) => s.unlocked);
	assert.equal(get(second.session).configured, false);
	assert.equal(
		await second.session.create({
			serverUrl: "https://clip.example",
			otc: "invite",
		}),
		true,
	);
	await waitState(t, first.session, (s) => s.configured);
	const before = get(first.session).signal;
	assert.equal(second.session.reset(), true);
	await waitState(t, first.session, (s) => s.status === "new");
	assert.equal(before.aborted, true);
	assert.equal(f.values.size, 0);
});
test("channel construction and posting failures fall back to password unlock", async (t) => {
	const f = await configured(t);
	for (const factory of [
		() => {
			throw new Error("unavailable");
		},
		() => {
			const channel = new BroadcastChannel(`failing-${crypto.randomUUID()}`);
			channel.postMessage = () => {
				throw new Error("Cannot clone");
			};
			return channel;
		},
	]) {
		const peer = f.tab(factory);
		assert.equal(get(peer.session).checking, false);
		assert.equal(await peer.session.unlock(password), true);
	}
});
test("invalid, unsolicited and stale grants cannot install access", async (t) => {
	const f = await configured(t);
	f.first.session.dispose();
	const messages: { type: string; id?: string; record: string }[] = [];
	const transport = new EventTarget();
	const peer = f.tab(() => ({
		postMessage(value) {
			messages.push(value);
		},
		close() {},
		addEventListener: transport.addEventListener.bind(transport),
		removeEventListener: transport.removeEventListener.bind(transport),
	}));
	const request = messages[0];
	assert.equal(request.type, "request");
	const saved = peer.persistence.read();
	assert(saved);
	const key = await peer.persistence.passwordKey(
		saved,
		password,
		new AbortController().signal,
	);
	function grant(
		id: string | undefined,
		record: string,
		grantKey: CryptoKey = key,
	) {
		transport.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "grant", id, record, key: grantKey },
			}),
		);
	}
	grant("wrong-request", request.record);
	grant(request.id, "different-record");
	await tick();
	assert.equal(get(peer.session).unlocked, false);
	const wrongKey = await crypto.subtle.generateKey(
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	grant(request.id, request.record, wrongKey);
	await tick();
	assert.equal(get(peer.session).unlocked, false);
	assert.equal(peer.session.reset(), true);
	grant(request.id, request.record);
	await tick();
	assert.equal(get(peer.session).status, "new");
});
test("a grant completing after a local password command cannot override that command", async (t) => {
	const f = await configured(t);
	f.first.session.dispose();
	const transport = new EventTarget();
	let request: { id: string; record: string } | undefined;
	const peer = f.tab(() => ({
		postMessage(data) {
			request = data;
		},
		close() {},
		addEventListener: transport.addEventListener.bind(transport),
		removeEventListener: transport.removeEventListener.bind(transport),
	}));
	assert(request);
	const saved = peer.persistence.read();
	assert(saved);
	const key = await peer.persistence.passwordKey(
		saved,
		password,
		new AbortController().signal,
	);
	const entered = deferred();
	const done = deferred<ArrayBuffer>();
	t.after(() => done.resolve(new ArrayBuffer(0)));
	const original = crypto.subtle.decrypt.bind(crypto.subtle);
	let intercept = true;
	t.mock.method(
		crypto.subtle,
		"decrypt",
		(...args: Parameters<typeof crypto.subtle.decrypt>) => {
			if (intercept) {
				intercept = false;
				entered.resolve();
				return done.promise;
			}
			return original(...args);
		},
	);
	transport.dispatchEvent(
		new MessageEvent("message", { data: { ...request, type: "grant", key } }),
	);
	await entered.promise;
	assert.equal(await peer.session.unlock(password), true);
	const context = get(peer.session).context;
	done.resolve(new ArrayBuffer(0));
	await tick();
	assert.equal(get(peer.session).context, context);
});

test("waiting tabs retry automatically after a donor password command fails", async (t) => {
	const f = await configured(t);
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
	let first = true;
	t.mock.method(
		crypto.subtle,
		"deriveKey",
		async (...args: Parameters<typeof crypto.subtle.deriveKey>) => {
			if (first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return derive(...args);
		},
	);
	const changing = f.first.session.changePassword(
		"wrong-password",
		"changed-password",
	);
	await entered.promise;
	const peer = f.tab();
	assert.equal(get(peer.session).configured, false);
	release.resolve();
	assert.equal(await changing, false);
	await waitState(t, peer.session, (state) => state.configured);
	assert.deepEqual(
		peer.session.identity().privateKey,
		f.first.session.identity().privateKey,
	);
});
