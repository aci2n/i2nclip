import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	passwordFromFile,
	promptPassword,
	readFileBounded,
	recoveryPath,
	writeExclusive,
} from "../cli/io.js";
import { editTags, run, UsageError } from "../cli/run.js";
import * as library from "../src/lib/index.js";

const id = "a".repeat(64);
const password = " test password ";

async function fixture(t) {
	const dir = await mkdtemp(join(tmpdir(), "i2nclip-cli-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const identity = await library.generatePrivateKey();
	const recovery = join(dir, "recovery.json");
	const passwordFile = join(dir, "password");
	const wrappedKey = await library.wrapPrivateKey(
		identity.privateKey,
		password,
		1,
	);
	await writeFile(
		recovery,
		library.recoveryFile({ serverUrl: "http://localhost:8080", wrappedKey }),
	);
	await writeFile(passwordFile, `${password}\r\n`);
	let output = "";
	let errors = "";
	const options = {
		stdout: (text) => {
			output += text;
		},
		stderr: (text) => {
			errors += text;
		},
	};
	const auth = ["--recovery", recovery, "--password-file", passwordFile];
	return {
		dir,
		identity,
		recovery,
		passwordFile,
		auth,
		options,
		output: () => output,
		errors: () => errors,
	};
}

test("XDG recovery path uses only an absolute configuration directory", () => {
	assert.equal(
		recoveryPath({ XDG_CONFIG_HOME: "/tmp/config" }, "/tmp/home"),
		"/tmp/config/i2nclip/recovery.json",
	);
	for (const env of [
		{},
		{ XDG_CONFIG_HOME: "" },
		{ XDG_CONFIG_HOME: "relative" },
	]) {
		assert.equal(
			recoveryPath(env, "/tmp/home"),
			"/tmp/home/.config/i2nclip/recovery.json",
		);
	}
});

test("help and invalid arguments never request credentials", async () => {
	let output = "";
	const options = {
		stdout: (text) => {
			output += text;
		},
		prompt: () => {
			throw new Error("Unexpected prompt");
		},
	};
	await run(["--help"], options);
	assert.match(output, /upload FILE/);
	for (const args of [
		[],
		["unknown"],
		["list", "--tags", "x".repeat(65)],
		["create", "--server", "invalid", "--otc", "code"],
		["upload"],
		["upload", "one", "two"],
		["delete", "bad-id"],
		["tags", id],
		["tags", id, "--tags", "a", "--add", "b"],
		["list", "--output", "x"],
		["create", "--server", "http://localhost"],
		["list", "--unknown"],
		["list", "--recovery", ""],
	]) {
		await assert.rejects(run(args, options), UsageError);
	}
});

test("encrypted extension recovery works through the XDG default and password file", async (t) => {
	const f = await fixture(t);
	const defaultFile = recoveryPath({ XDG_CONFIG_HOME: f.dir });
	await import("node:fs/promises").then(({ mkdir }) =>
		mkdir(join(f.dir, "i2nclip")),
	);
	await writeFile(defaultFile, await readFile(f.recovery));
	let called;
	await run(
		[
			"list",
			"--password-file",
			f.passwordFile,
			"--tags",
			"cat",
			"--after",
			"cursor",
		],
		{
			...f.options,
			env: { XDG_CONFIG_HOME: f.dir },
			api: {
				...library,
				list: async (options) => {
					called = options;
					return {
						items: [
							{
								id,
								metadata: { name: "a" },
								thumb: new Uint8Array([1]),
								tokens: ["secret"],
								metaHash: "hash",
							},
						],
						next: "next",
					};
				},
			},
		},
	);
	assert.equal(called.privateKey, f.identity.privateKey);
	assert.equal(called.serverUrl, "http://localhost:8080");
	assert.equal(called.tags, "cat");
	assert.equal(called.after, "cursor");
	assert.deepEqual(JSON.parse(f.output()), {
		items: [{ id, metadata: { name: "a" }, metaHash: "hash" }],
		next: "next",
	});
});

test("creation saves a protected recovery before registration and retries the same identity", async (t) => {
	const f = await fixture(t);
	const config = join(f.dir, "config");
	const saved = recoveryPath({ XDG_CONFIG_HOME: config });
	let publicKey;
	const api = {
		...library,
		registerKey: async (options) => {
			publicKey = options.publicKey;
			const recovered = library.parseRecoveryFile(
				await readFile(saved, "utf8"),
			);
			const privateKey = await library.unwrapPrivateKey(
				recovered.wrappedKey,
				password,
			);
			assert.equal(
				(await library.loadKey(privateKey)).registrationKey,
				publicKey,
			);
			throw new Error("registration failed");
		},
	};
	await assert.rejects(
		run(
			[
				"create",
				"--server",
				"http://localhost:8080",
				"--otc",
				"invite",
				"--password-file",
				f.passwordFile,
			],
			{ ...f.options, api, env: { XDG_CONFIG_HOME: config } },
		),
		/registration failed/,
	);
	assert.match(f.errors(), /Retry:.*register/);
	assert.equal((await stat(saved)).mode & 0o777, 0o600);
	assert.equal((await stat(join(config, "i2nclip"))).mode & 0o777, 0o700);
	let registrations = 0;
	await run(
		[
			"register",
			"--recovery",
			saved,
			"--password-file",
			f.passwordFile,
			"--otc",
			"new-invite",
		],
		{
			...f.options,
			api: {
				...library,
				isKeyRegistered: async () => false,
				registerKey: async (options) => {
					registrations++;
					assert.equal(options.publicKey, publicKey);
				},
			},
		},
	);
	assert.equal(registrations, 1);
	await run(
		[
			"register",
			"--recovery",
			saved,
			"--password-file",
			f.passwordFile,
			"--otc",
			"used-invite",
		],
		{
			...f.options,
			api: {
				...library,
				isKeyRegistered: async () => true,
				registerKey: async () => {
					throw new Error("must not spend invitation");
				},
			},
		},
	);
	await assert.rejects(
		run(
			[
				"create",
				"--server",
				"http://localhost:8080",
				"--otc",
				"invite",
				"--recovery",
				saved,
				"--password-file",
				f.passwordFile,
			],
			{ ...f.options, api },
		),
		{ code: "EEXIST" },
	);
});

test("creation confirms interactive passwords and rejects short passwords", async (t) => {
	const f = await fixture(t);
	const args = [
		"create",
		"--server",
		"http://localhost",
		"--otc",
		"code",
		"--recovery",
		join(f.dir, "new.json"),
	];
	await assert.rejects(
		run(args, { ...f.options, prompt: async () => "short" }),
		/at least 8/,
	);
	let prompts = 0;
	await assert.rejects(
		run(args, {
			...f.options,
			prompt: async () => (++prompts === 1 ? "password" : "different"),
		}),
		/do not match/,
	);
	assert.equal(prompts, 2);
});

test("wrong passwords, damaged recovery and missing files fail before API calls", async (t) => {
	const f = await fixture(t);
	await writeFile(f.passwordFile, "wrong");
	await assert.rejects(run(["list", ...f.auth], f.options), /Wrong password/);
	await writeFile(f.recovery, "{}");
	await assert.rejects(run(["list", ...f.auth], f.options), /Invalid recovery/);
	await assert.rejects(
		run(["list", "--recovery", join(f.dir, "missing")], f.options),
		{ code: "ENOENT" },
	);
	assert.equal(f.output(), "");
});

test("upload reads exactly one file and preserves its bytes, filename and tags", async (t) => {
	const f = await fixture(t);
	const file = join(f.dir, "sample.bin");
	await writeFile(file, Buffer.from([0, 1, 255]));
	await run(["upload", file, "--tags", "One,two", ...f.auth], {
		...f.options,
		api: {
			...library,
			upload: async (options) => {
				assert.deepEqual([...options.bytes], [0, 1, 255]);
				assert.equal(options.name, "sample.bin");
				assert.equal(options.tags, "One,two");
				assert.equal(options.contentType, "application/octet-stream");
				assert.equal(options.thumb, undefined);
				return { id };
			},
		},
	});
	assert.deepEqual(JSON.parse(f.output()), { id });
	await assert.rejects(
		run(["upload", file, ...f.auth], {
			...f.options,
			api: {
				...library,
				MAX_FILE_BYTES: 2,
				upload: () => {
					throw new Error("must not upload");
				},
			},
		}),
		/limit/,
	);
});

test("bounded reads reject stat size before streaming and count streamed bytes", async (t) => {
	const f = await fixture(t);
	const file = join(f.dir, "large");
	await writeFile(file, "12345");
	const handle = await open(file);
	const prototype = Object.getPrototypeOf(handle);
	let reads = 0;
	const original = prototype.createReadStream;
	t.mock.method(prototype, "createReadStream", function (options) {
		reads++;
		return original.call(this, options);
	});
	await assert.rejects(readFileBounded(file, 3), /limit/);
	assert.equal(reads, 0);
	t.mock.method(prototype, "stat", async () => ({
		size: 1,
		isFile: () => true,
	}));
	await assert.rejects(readFileBounded(file, 3), /limit/);
	assert.equal(reads, 1);
	await handle.close();
});

test("downloads create files exclusively after verified content retrieval", async (t) => {
	const f = await fixture(t);
	const output = join(f.dir, "download");
	const args = ["download", id, "--output", output, ...f.auth];
	await assert.rejects(
		run(args, {
			...f.options,
			api: {
				...library,
				getContent: async () => {
					throw new Error("Content hash mismatch.");
				},
			},
		}),
		/hash mismatch/,
	);
	await assert.rejects(stat(output), { code: "ENOENT" });
	const api = { ...library, getContent: async () => new Uint8Array([1, 2]) };
	await run(args, { ...f.options, api });
	assert.deepEqual([...(await readFile(output))], [1, 2]);
	await assert.rejects(run(args, { ...f.options, api }), { code: "EEXIST" });
	assert.deepEqual([...(await readFile(output))], [1, 2]);
});

test("tag edits retrieve one metadata item and preserve thumbnail and other fields", async (t) => {
	const f = await fixture(t);
	const thumb = new Uint8Array([3, 4]);
	let reads = 0;
	let changes;
	await run(["tags", id, "--remove", "ONE", "--add", "Three, TWO", ...f.auth], {
		...f.options,
		api: {
			...library,
			list: () => {
				throw new Error("must not scan pages");
			},
			getMetadata: async (options) => {
				assert.equal(options.id, id);
				reads++;
				return {
					metadata: {
						name: "photo",
						tags: ["One", "Two"],
						image: { width: 10 },
					},
					thumb,
					metaHash: "original",
				};
			},
			updateMetadata: async (options) => {
				changes = options;
				return { conflict: false, metaHash: "new" };
			},
		},
	});
	assert.equal(reads, 1);
	assert.deepEqual(changes.metadata, {
		name: "photo",
		tags: ["Two", "Three"],
		image: { width: 10 },
	});
	assert.equal(changes.thumb, thumb);
	assert.equal(changes.prevMetaHash, "original");
	assert.deepEqual(
		editTags(["é", "Keep"], { remove: ["e\u0301"], add: ["KEEP,New"] }),
		["Keep", "New"],
	);
	assert.deepEqual(editTags(["Old"], { tags: "" }), []);
});

test("tag conflicts and undecryptable metadata never trigger retries", async (t) => {
	const f = await fixture(t);
	let writes = 0;
	const args = ["tags", id, "--tags", "new", ...f.auth];
	const api = {
		...library,
		getMetadata: async () => ({
			metadata: { tags: [] },
			thumb: null,
			metaHash: "old",
		}),
		updateMetadata: async () => {
			writes++;
			return { conflict: true };
		},
	};
	await assert.rejects(
		run(args, { ...f.options, api }),
		/changed concurrently/,
	);
	assert.equal(writes, 1);
	await assert.rejects(
		run(args, {
			...f.options,
			api: { ...api, getMetadata: async () => ({ metadata: null }) },
		}),
		/decrypt metadata/,
	);
	assert.equal(writes, 1);
});

test("delete uses the shared API and cancellation cannot write a download", async (t) => {
	const f = await fixture(t);
	let deleted;
	await run(["delete", id, ...f.auth], {
		...f.options,
		api: {
			...library,
			remove: async (options) => {
				deleted = options.id;
			},
		},
	});
	assert.equal(deleted, id);
	const controller = new AbortController();
	const output = join(f.dir, "aborted");
	await assert.rejects(
		run(["download", id, "--output", output, ...f.auth], {
			...f.options,
			signal: controller.signal,
			api: {
				...library,
				getContent: async ({ signal }) => {
					assert.equal(signal, controller.signal);
					controller.abort();
					return new Uint8Array([1]);
				},
			},
		}),
		{ name: "AbortError" },
	);
	await assert.rejects(stat(output), { code: "ENOENT" });
	await assert.rejects(writeExclusive(output, "x", controller.signal), {
		name: "AbortError",
	});
});

test("password files preserve whitespace and remove only one line ending", async (t) => {
	const f = await fixture(t);
	assert.equal(await passwordFromFile(f.passwordFile), password);
	await writeFile(f.passwordFile, " secret \n\n");
	assert.equal(await passwordFromFile(f.passwordFile), " secret \n");
});

test("hidden prompt restores terminal state and handles editing and interruption", async () => {
	const input = new PassThrough();
	input.isTTY = true;
	input.setRawMode = (raw) => {
		input.isRaw = raw;
	};
	input.pause();
	let output = "";
	const terminal = {
		isTTY: true,
		write: (text) => {
			output += text;
		},
	};
	const result = promptPassword("Password: ", undefined, input, terminal);
	input.emit("keypress", "x", { name: "x" });
	input.emit("keypress", "", { name: "backspace" });
	input.emit("keypress", "secret", {});
	input.emit("keypress", "\r", { name: "return" });
	assert.equal(await result, "secret");
	assert.equal(output, "Password: \n");
	assert.equal(input.isRaw, false);
	assert.equal(input.isPaused(), true);
	const interrupted = promptPassword("Password: ", undefined, input, terminal);
	input.emit("keypress", "\x03", { ctrl: true, name: "c" });
	await assert.rejects(interrupted, { name: "AbortError" });
	assert.equal(input.listenerCount("keypress"), 0);
	assert.throws(
		() => promptPassword("Password: ", undefined, { isTTY: false }, terminal),
		/noninteractive/,
	);
	input.destroy();
});

test("Node executable supports stdin passwords and returns meaningful exit codes", async (t) => {
	const f = await fixture(t);
	async function execute(args, stdin = "") {
		const childEnv = { ...process.env };
		delete childEnv.NODE_TEST_CONTEXT;
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("../cli/index.js", import.meta.url)), ...args],
			{ stdio: ["pipe", "pipe", "pipe"], env: childEnv },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (bytes) => {
			stdout += bytes;
		});
		child.stderr.on("data", (bytes) => {
			stderr += bytes;
		});
		child.stdin.end(stdin);
		const code = await new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});
		return { code, stdout, stderr };
	}
	assert.equal((await execute(["--help"])).code, 0);
	assert.equal((await execute(["upload", "one", "two"])).code, 2);
	const failure = await execute(
		["list", "--recovery", f.recovery, "--password-file", "/dev/stdin"],
		"wrong\n",
	);
	assert.equal(failure.code, 1);
	assert.match(failure.stderr, /Wrong password/);
	assert.equal(failure.stdout, "");
});

test("authenticated CLI creation and retry use a separate authorizing recovery and password", async (t) => {
	const f = await fixture(t);
	const destination = join(f.dir, "team.json"),
		destinationPassword = join(f.dir, "team-password");
	await writeFile(destinationPassword, "team-password\n");
	const flags = [
		"--recovery",
		destination,
		"--password-file",
		destinationPassword,
		"--authorize-with",
		f.recovery,
		"--authorizer-password-file",
		f.passwordFile,
	];
	let publicKey,
		calls = 0;
	const api = {
		...library,
		registerAuthenticatedKey: async (options) => {
			calls++;
			publicKey = options.publicKey;
			assert.equal(options.privateKey, f.identity.privateKey);
			const saved = library.parseRecoveryFile(
				await readFile(destination, "utf8"),
			);
			const key = await library.loadKey(
				await library.unwrapPrivateKey(saved.wrappedKey, "team-password"),
			);
			assert.equal(key.registrationKey, publicKey);
			if (calls === 1) throw new Error("lost response");
		},
		isKeyRegistered: async () => false,
	};
	await assert.rejects(
		run(["create", "--server", "http://localhost:8080", ...flags], {
			...f.options,
			api,
		}),
		/lost response/,
	);
	const first = publicKey;
	await run(["register", ...flags], { ...f.options, api });
	assert.equal(calls, 2);
	assert.equal(publicKey, first);
	assert.notEqual(publicKey, f.identity.publicKey);
	await assert.rejects(
		run(["register", ...flags, "--otc", "invite"], { ...f.options, api }),
		/exactly one/,
	);
	const other = library.recoveryFile({
		serverUrl: "https://other.example",
		wrappedKey: library.parseRecoveryFile(await readFile(f.recovery, "utf8"))
			.wrappedKey,
	});
	await writeFile(f.recovery, other);
	await assert.rejects(
		run(["register", ...flags], { ...f.options, api }),
		/same server/,
	);
});
