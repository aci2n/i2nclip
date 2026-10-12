import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { passwordFromFile, readFileBounded } from "../cli/io.js";
import { run as runCli } from "../cli/run.js";
import * as library from "../src/lib/index.js";
import { createPairingCrypto } from "../src/lib/pairing/crypto.js";
import { pairingRelay } from "../src/lib/pairing/service.js";
import { pairingContext, pairingSecret } from "../src/lib/protocol/pairing.js";

export const DEFAULT_SERVER = "https://clip.i2n.duckdns.org";
export const FILES = [
	{ name: "small.bin", size: 1024, label: "1 KiB" },
	{ name: "medium.bin", size: 1024 * 1024, label: "1 MiB" },
	{ name: "maximum.bin", size: 32 * 1024 * 1024, label: "32 MiB" },
];

function check(condition) {
	if (!condition) throw new Error("Smoke assertion failed.");
}

function same(value, expected) {
	check(JSON.stringify(value) === JSON.stringify(expected));
}

function status(error) {
	if (Number.isInteger(error?.status)) return ` (HTTP ${error.status})`;
	if (error?.name === "TimeoutError") return " (timeout)";
	const code = error?.cause?.code ?? error?.code;
	const connectionErrors = [
		"ETIMEDOUT",
		"ECONNREFUSED",
		"ENOTFOUND",
		"EAI_AGAIN",
		"ENETUNREACH",
		"ECONNRESET",
		"CERT_HAS_EXPIRED",
		"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		"ERR_TLS_CERT_ALTNAME_INVALID",
	];
	return connectionErrors.includes(code) ? ` (${code})` : "";
}

export async function smoketest({
	serverUrl = DEFAULT_SERVER,
	directory = fileURLDirectory(),
	cli = runCli,
	api = library,
	report = (text) => process.stdout.write(`${text}\n`),
	signal,
	commandTimeoutMs = 120_000,
	cleanupTimeoutMs = 30_000,
	files = FILES,
	makeRandom = randomBytes,
	relay = pairingRelay,
} = {}) {
	const recoveryPath = join(resolve(directory), "recovery.json");
	const passwordPath = join(resolve(directory), "pw");
	const tag = `smoke-${randomUUID()}`;
	const ids = new Set();
	let stage = "credentials";
	let failure;
	let failedStage;
	let temporary;
	let credentials;
	let uploaded = false;
	let cleanupFailed = false;
	let pairingRoom;

	const bounded = (parent) => {
		const timeout = AbortSignal.timeout(commandTimeoutMs);
		return parent ? AbortSignal.any([parent, timeout]) : timeout;
	};
	const command = async (args, parent = signal) => {
		let output = "";
		await cli(
			[...args, "--recovery", recoveryPath, "--password-file", passwordPath],
			{
				signal: bounded(parent),
				stdout: (text) => {
					output += text;
				},
				// CLI errors can contain an upstream response. Report only the stage/status.
				stderr: () => {},
			},
		);
		return JSON.parse(output);
	};
	const search = (tags, parent = signal, after) =>
		command(
			["list", "--tags", tags, ...(after ? ["--after", after] : [])],
			parent,
		);
	const getMetadata = (id, parent = signal) =>
		api.getMetadata({ ...credentials, id, signal: bounded(parent) });
	const checkTags = async (id, tags) => {
		const page = await search(tag);
		const item = page.items.find((entry) => entry.id === id);
		check(item);
		same(item.metadata.tags, tags);
		return item;
	};

	try {
		api.checkServer(serverUrl);
		serverUrl = new URL(serverUrl).origin;
		const password = await passwordFromFile(passwordPath, signal);
		let recovery;
		try {
			recovery = (
				await api.openRecovery(
					(
						await readFileBounded(recoveryPath, api.MAX_RECOVERY_BYTES, signal)
					).toString("utf8"),
					password,
				)
			).libraries[0];
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (recovery) {
			stage = "recovery server origin";
			check(new URL(recovery.serverUrl).origin === serverUrl);
		}
		stage = "registration";
		const otc = (
			await readFileBounded(join(resolve(directory), "otc"), 4096, signal)
		)
			.toString("utf8")
			.trim();
		check(otc.length > 0);
		if (recovery) await command(["register", "--otc", otc]);
		else {
			await command(["create", "--server", serverUrl, "--otc", otc]);
			recovery = (
				await api.openRecovery(
					(
						await readFileBounded(recoveryPath, api.MAX_RECOVERY_BYTES, signal)
					).toString("utf8"),
					password,
				)
			).libraries[0];
		}
		credentials = {
			serverUrl,
			privateKey: recovery.privateKey,
		};
		report("PASS registration (encrypted identity retained for reuse)");
		stage = "pairing authentication";
		const pairing = relay(serverUrl, bounded(signal));
		pairingRoom = await pairing.create(credentials.privateKey);
		const context = pairingContext(serverUrl, pairingRoom);
		const sender = createPairingCrypto();
		const receiver = createPairingCrypto();
		const secret = pairingSecret();
		await sender("senderSetup", { context, secret });
		const joined = await pairing.join(
			pairingRoom.id,
			await receiver("receiverStart", { secret }),
		);
		const exchange = async (room, peer, step, message) => {
			const submitted = await pairing.submit(room, step, message);
			check(submitted.step === step && submitted.message === message);
			const snapshot = await pairing.poll(peer);
			check(pairingContext(serverUrl, snapshot) === context);
			check(snapshot.step === step && snapshot.message === message);
			return snapshot.message;
		};
		check(pairingContext(serverUrl, joined) === context && joined.step === 1);
		const response = await exchange(
			pairingRoom,
			joined,
			2,
			await sender("senderResponse", { message: joined.message }),
		);
		const finish = await exchange(
			joined,
			pairingRoom,
			3,
			await receiver("receiverFinish", { context, message: response }),
		);
		await sender("senderFinish", { message: finish });
		const verification = await sender("verificationCode", {});
		check(
			/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(
				verification,
			),
		);
		same(await receiver("verificationCode", {}), verification);
		report("PASS pairing authentication and verification codes");
		stage = "pairing encrypted identity transfer";
		const identity = {
			v: 1,
			...credentials,
			publicKey: (await api.loadKey(credentials.privateKey)).registrationKey,
		};
		const transfer = await exchange(
			pairingRoom,
			joined,
			4,
			await sender("transfer", { value: identity }),
		);
		same(await receiver("receive", { message: transfer }), identity);
		const acknowledgment = await exchange(
			joined,
			pairingRoom,
			5,
			await receiver("acknowledge", {}),
		);
		await sender("verifyAcknowledgment", { message: acknowledgment });
		report("PASS pairing encrypted identity and acknowledgment");
		stage = "pairing cancellation";
		await pairing.cancel(pairingRoom);
		pairingRoom = undefined;
		report("PASS pairing cancellation");
		temporary = await mkdtemp(join(tmpdir(), "i2nclip-smoke-"));
		const saved = [];
		for (const file of files) {
			stage = `upload ${file.label}`;
			const path = join(temporary, file.name);
			await writeFile(path, makeRandom(file.size), { mode: 0o600, signal });
			uploaded = true;
			const item = await command([
				"upload",
				path,
				"--tags",
				`${tag},Original,Keep`,
				"--content-type",
				"application/octet-stream",
			]);
			ids.add(item.id);
			check(/^[a-f0-9]{64}$/.test(item.id));
			saved.push({ ...file, id: item.id, path });
			report(`PASS upload ${file.label}`);
		}
		stage = "list/search metadata";
		const page = await search(`${tag},original,KEEP`);
		check(page.items.length === files.length && page.next === null);
		for (const file of saved) {
			const item = page.items.find((entry) => entry.id === file.id);
			check(item);
			same(item.metadata, {
				name: file.name,
				content_type: "application/octet-stream",
				size: file.size,
				tags: [tag, "Original", "Keep"],
			});
			check(item.bytes > file.size);
		}
		report("PASS list/search metadata");
		for (const file of saved) {
			stage = `download verification ${file.label}`;
			const path = join(temporary, `download-${file.name}`);
			await command(["download", file.id, "--output", path]);
			check((await readFile(file.path)).equals(await readFile(path)));
			report(`PASS download verification ${file.label}`);
		}
		stage = "metadata tag edits";
		const id = saved[0].id;
		const initial = await getMetadata(id);
		await command(["tags", id, "--tags", `${tag},Keep,Replace`]);
		await checkTags(id, [tag, "Keep", "Replace"]);
		await command(["tags", id, "--remove", "REPLACE", "--add", "Added,KEEP"]);
		const changed = await checkTags(id, [tag, "Keep", "Added"]);
		same(changed.metadata, {
			...initial.metadata,
			tags: [tag, "Keep", "Added"],
		});
		const current = await getMetadata(id);
		same(current.thumb, initial.thumb);
		check(current.metaHash !== initial.metaHash);
		check((await search(`${tag},replace`)).items.length === 0);
		same(
			(await search(`${tag},ADDED`)).items.map((item) => item.id),
			[id],
		);
		await command(["tags", id, "--remove", "ADDED"]);
		await checkTags(id, [tag, "Keep"]);
		check((await search(`${tag},added`)).items.length === 0);
		report("PASS metadata tag edits and search");
		stage = "delete and missing metadata";
		for (const file of saved) {
			await command(["delete", file.id]);
			ids.delete(file.id);
		}
		const empty = await search(tag);
		check(empty.items.length === 0 && empty.next === null);
		try {
			await getMetadata(id);
			throw new Error("Deleted metadata is still present.");
		} catch (error) {
			if (error.status !== 404) throw error;
		}
		report("PASS deletion and metadata 404");
	} catch (error) {
		failure = error;
		failedStage = stage;
	} finally {
		if (pairingRoom) {
			try {
				await relay(serverUrl, AbortSignal.timeout(cleanupTimeoutMs)).cancel(
					pairingRoom,
				);
				report("PASS pairing cleanup");
			} catch {
				cleanupFailed = true;
				report("FAIL pairing cleanup (room will expire)");
			}
		}
		if (uploaded && credentials) {
			// Independent of the interrupted/expired command; bounded as a whole.
			const cleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
			try {
				let after;
				const cursors = new Set();
				do {
					const page = await search(tag, cleanupSignal, after);
					for (const item of page.items) ids.add(item.id);
					after = page.next;
					if (after) {
						check(!cursors.has(after));
						cursors.add(after);
					}
				} while (after);
			} catch {
				cleanupFailed = true;
				report(`FAIL cleanup search; inspect run tag ${tag}`);
			}
			for (const id of ids) {
				try {
					await command(["delete", id], cleanupSignal);
					ids.delete(id);
				} catch (error) {
					if (error.status === 404) ids.delete(id);
					else cleanupFailed = true;
				}
			}
			if (ids.size)
				report(`FAIL cleanup; remaining IDs: ${[...ids].join(", ")}`);
			if (!cleanupFailed) report("PASS cleanup");
		}
		if (temporary) {
			try {
				await rm(temporary, { recursive: true, force: true });
			} catch {
				cleanupFailed = true;
				report("FAIL temporary file cleanup");
			}
		}
	}
	if (failure || cleanupFailed) {
		const error = new Error(
			`Smoke test failed at ${failure ? failedStage : "cleanup"}${status(failure)}.`,
		);
		if (signal?.aborted || failure?.name === "AbortError")
			error.name = "AbortError";
		throw error;
	}
	report("PASS smoketest (1 KiB, 1 MiB, 32 MiB)");
}

function fileURLDirectory() {
	return fileURLToPath(new URL("./", import.meta.url));
}
