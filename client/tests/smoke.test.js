import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../cli/run.js";
import { FILES, smoketest } from "../smoke/run.js";
import * as library from "../src/lib/index.js";

const serverUrl = "https://smoke.example";
const small = FILES.map((file, index) => ({ ...file, size: 8 * (index + 1) }));
const password = "secret-password";
const otc = "secret-invitation";

function httpError(status, text = "upstream failure") {
	const error = new Error(text);
	error.status = status;
	return error;
}

async function fixture(t, { create = false, origin = serverUrl } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "i2nclip-smoke-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "pw"), `${password}\n`, { mode: 0o600 });
	await writeFile(join(directory, "otc"), `${otc}\n`, { mode: 0o600 });
	let privateKey;
	if (!create) {
		privateKey = (await library.generatePrivateKey()).privateKey;
		await writeFile(
			join(directory, "recovery.json"),
			await library.exportRecovery(
				[{ name: "Library", serverUrl: origin, privateKey }],
				password,
				"library",
			),
		);
	}
	const state = {
		registered: !create,
		registrations: 0,
		nextId: 0,
		items: new Map(),
		calls: [],
		logs: [],
		generated: [],
		localPaths: [],
		pairingSteps: [],
		pairingCanceled: 0,
	};
	let room;
	const relay = (_origin, signal) => ({
		create: async () => {
			room = {
				v: 1,
				id: "2345",
				instance: "a".repeat(22),
				step: 0,
				capability: "sender",
			};
			return { ...room };
		},
		join: async (_id, message) => {
			room = { ...room, step: 1, message };
			return { ...room, capability: "receiver" };
		},
		submit: async (_participant, step, message) => {
			signal.throwIfAborted();
			if (state.pairingFailure === step) {
				throw httpError(503, password);
			}
			assert.equal(step, room.step + 1);
			state.pairingSteps.push(step);
			room = { ...room, step, message };
			return { ...room };
		},
		poll: async () => ({ ...room }),
		cancel: async () => {
			signal.throwIfAborted();
			state.pairingCanceled++;
		},
	});
	const api = {
		...library,
		isKeyRegistered: async () => state.registered,
		registerKey: async (options) => {
			assert.equal(options.otc, otc);
			state.registrations++;
			if (state.registrationFailure) {
				throw httpError(403, `${otc} ${password}`);
			}
			state.registered = true;
		},
		upload: async (options) => {
			const id = (++state.nextId).toString(16).padStart(64, "0");
			const payload = join(directory, `payload-${id}`);
			await writeFile(payload, options.bytes);
			const metadata = {
				name: options.name,
				content_type: options.contentType,
				size: options.bytes.length,
				tags: library.uniqueTags(options.tags),
			};
			state.items.set(id, {
				id,
				bytes: options.bytes.length + 29,
				metadata,
				thumb: null,
				metaHash: "initial",
				payload,
			});
			if (state.onUpload) {
				await state.onUpload(options);
			}
			return { id, metadata, metaHash: "initial" };
		},
		list: async (options) => {
			if (state.onList) {
				await state.onList(options);
			}
			const tokens = library.parseTagList(options.tags);
			return {
				items: [...state.items.values()]
					.filter((item) => {
						const tags = library.parseTagList(item.metadata.tags);
						return tokens.every((tag) => tags.includes(tag));
					})
					.map(({ payload: _payload, ...item }) => item),
				next: null,
			};
		},
		getContent: async (options) => {
			if (state.corruptDownload) {
				return new Uint8Array([255]);
			}
			return readFile(state.items.get(options.id).payload);
		},
		getMetadata: async (options) => {
			const item = state.items.get(options.id);
			if (!item) {
				state.deletedMetadataChecked = true;
				throw httpError(state.deletedStatus ?? 404);
			}
			return { ...item, metadata: { ...item.metadata } };
		},
		updateMetadata: async (options) => {
			const item = state.items.get(options.id);
			assert.equal(options.prevMetaHash, item.metaHash);
			item.metadata = options.metadata;
			item.metaHash += "-updated";
			return { conflict: false, metaHash: item.metaHash };
		},
		remove: async (options) => {
			if (state.deleteFailure) {
				throw httpError(503, `${otc} ${password} ${privateKey}`);
			}
			if (!state.items.delete(options.id)) {
				throw httpError(404);
			}
		},
	};
	const cli = async (args, options) => {
		state.calls.push({ command: args[0], signal: options.signal });
		if (args[0] === "upload") {
			state.localPaths.push(args[1]);
		}
		if (args[0] === "download") {
			state.localPaths.push(args[args.indexOf("--output") + 1]);
		}
		await run(args, { ...options, api });
	};
	return {
		directory,
		api,
		cli,
		relay,
		state,
		report: (line) => state.logs.push(line),
		serverUrl,
		files: small,
		makeRandom: (size) => {
			state.generated.push(size);
			return randomBytes(size);
		},
	};
}

test("smoke defaults include a maximum-size file and verify the complete CLI workflow", async (t) => {
	assert.deepEqual(
		FILES.map((file) => file.size),
		[1024, 1048576, library.MAX_FILE_BYTES],
	);
	const f = await fixture(t);
	await smoketest({ ...f, files: FILES });
	assert.deepEqual(
		f.state.generated,
		FILES.map((file) => file.size),
	);
	assert.equal(f.state.registrations, 0);
	assert.deepEqual(f.state.pairingSteps, [2, 3, 4, 5]);
	assert.equal(f.state.pairingCanceled, 1);
	assert.equal(f.state.items.size, 0);
	assert.equal(
		f.state.calls.filter((call) => call.command === "upload").length,
		3,
	);
	assert.equal(
		f.state.calls.filter((call) => call.command === "tags").length,
		3,
	);
	assert.equal(f.state.deletedMetadataChecked, true);
	assert.match(f.state.logs.at(-1), /PASS smoketest/);
	for (const path of f.state.localPaths) {
		await assert.rejects(stat(path), { code: "ENOENT" });
	}
	for (const secret of [password, otc]) {
		assert.ok(!f.state.logs.join("\n").includes(secret));
	}
});

test("pairing failure cancels its room before any upload and hides secrets", async (t) => {
	const f = await fixture(t);
	f.state.pairingFailure = 4;
	await assert.rejects(smoketest(f), {
		message:
			"Smoke test failed at pairing encrypted identity transfer (HTTP 503).",
	});
	assert.equal(f.state.pairingCanceled, 1);
	assert.equal(f.state.items.size, 0);
	assert.ok(!f.state.logs.join("\n").includes(password));
});

test("first run creates protected recovery and later runs reuse the same identity", async (t) => {
	const f = await fixture(t, { create: true });
	await smoketest(f);
	assert.equal(f.state.registrations, 1);
	const path = join(f.directory, "recovery.json");
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const original = await readFile(path);
	await smoketest(f);
	assert.equal(f.state.registrations, 1);
	assert.deepEqual(await readFile(path), original);
});

test("registration failure keeps recovery for retry and hides upstream secrets", async (t) => {
	const f = await fixture(t, { create: true });
	f.state.registrationFailure = true;
	await assert.rejects(smoketest(f), {
		message: "Smoke test failed at registration (HTTP 403).",
	});
	const path = join(f.directory, "recovery.json");
	const original = await readFile(path);
	f.state.registrationFailure = false;
	await smoketest(f);
	assert.deepEqual(await readFile(path), original);
	assert.equal(f.state.registrations, 2);
	assert.ok(!f.state.logs.join("\n").includes(otc));
	assert.ok(!f.state.logs.join("\n").includes(password));
});

test("a recovery for another server fails before registration or uploads", async (t) => {
	const f = await fixture(t, { origin: "https://other.example" });
	await assert.rejects(smoketest(f), /recovery server origin/);
	assert.equal(f.state.calls.length, 0);
});

test("cleanup discovers an upload whose successful response was lost", async (t) => {
	const f = await fixture(t);
	f.state.onUpload = async () => {
		throw new Error(`${otc} ${password}`);
	};
	await assert.rejects(smoketest(f), {
		message: "Smoke test failed at upload 1 KiB.",
	});
	assert.equal(f.state.items.size, 0);
	assert.ok(f.state.logs.includes("PASS cleanup"));
	assert.ok(!f.state.logs.join("\n").includes(password));
	for (const path of f.state.localPaths) {
		await assert.rejects(stat(path), { code: "ENOENT" });
	}
});

test("byte verification failures clean up every uploaded item", async (t) => {
	const f = await fixture(t);
	f.state.corruptDownload = true;
	await assert.rejects(smoketest(f), /download verification 1 KiB/);
	assert.equal(f.state.items.size, 0);
	assert.equal(
		f.state.calls.filter((call) => call.command === "delete").length,
		3,
	);
});

test("tag verification failures stop the run and clean up", async (t) => {
	const f = await fixture(t);
	f.api.updateMetadata = async () => ({ conflict: false, metaHash: "ignored" });
	await assert.rejects(smoketest(f), /metadata tag edits/);
	assert.equal(f.state.items.size, 0);
});

test("commands time out and cleanup uses a fresh signal", async (t) => {
	const f = await fixture(t);
	f.state.onUpload = ({ signal }) =>
		new Promise((_, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			}),
		);
	// Keep the timer alive while the fake transport waits (real fetch owns sockets).
	const keepAlive = setInterval(() => {}, 1000);
	try {
		await assert.rejects(
			smoketest({ ...f, commandTimeoutMs: 1000 }),
			/upload 1 KiB/,
		);
	} finally {
		clearInterval(keepAlive);
	}
	assert.equal(f.state.items.size, 0);
	assert.equal(
		f.state.calls.find((call) => call.command === "upload").signal.aborted,
		true,
	);
	assert.equal(
		f.state.calls.find((call) => call.command === "delete").signal.aborted,
		false,
	);
});

test("interruption still cleans up with an independent signal", async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	f.state.onUpload = ({ signal }) => {
		controller.abort();
		signal.throwIfAborted();
	};
	await assert.rejects(smoketest({ ...f, signal: controller.signal }), {
		name: "AbortError",
	});
	assert.equal(f.state.items.size, 0);
	assert.equal(
		f.state.calls.find((call) => call.command === "delete").signal.aborted,
		false,
	);
});

test("cleanup errors identify remaining IDs without exposing secrets", async (t) => {
	const f = await fixture(t);
	f.state.corruptDownload = true;
	f.state.deleteFailure = true;
	await assert.rejects(smoketest(f), /download verification/);
	assert.equal(f.state.items.size, 3);
	const logs = f.state.logs.join("\n");
	for (const id of f.state.items.keys()) {
		assert.ok(logs.includes(id));
	}
	for (const secret of [password, otc]) {
		assert.ok(!logs.includes(secret));
	}
});

test("cleanup failure makes an otherwise successful smoke test fail", async (t) => {
	const f = await fixture(t);
	f.state.onList = () => {
		if (f.state.deletedMetadataChecked) {
			throw httpError(503);
		}
	};
	await assert.rejects(smoketest(f), /failed at cleanup/);
	assert.equal(f.state.items.size, 0);
	assert.match(
		f.state.logs.at(-1),
		/FAIL cleanup search; inspect run tag smoke-/,
	);
});

test("deleted metadata must produce HTTP 404", async (t) => {
	const f = await fixture(t);
	f.state.deletedStatus = 503;
	await assert.rejects(
		smoketest(f),
		/delete and missing metadata \(HTTP 503\)/,
	);
});
