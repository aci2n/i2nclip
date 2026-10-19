import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import http from "node:http";
import { promisify } from "node:util";
import { registerKey } from "../src/lib/api.ts";
import {
	CHUNK_BYTES,
	createContent,
	encryptChunk,
} from "../src/lib/protocol/content.ts";
import type { LoadedKey } from "../src/lib/protocol/crypto.ts";
import {
	authorizationHeader,
	encrypt,
	freshNonce,
	loadKey,
	metaAad,
} from "../src/lib/protocol/crypto.ts";
import { encodeUpload } from "../src/lib/protocol/frame.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { assertPresent } from "./assert.ts";
import {
	database as fixture,
	issueOtc,
	startServer,
	stopServer,
} from "./process.ts";

// Explicit Linux-only resource profile; never runs as part of npm test.

const exec = promisify(execFile);
let origin: string;
const delay = (ms: number | undefined) =>
	new Promise((resolve) => setTimeout(resolve, ms));
const heldResponses = new Set<IncomingMessage>();
async function status(pid: number | undefined) {
	const [text, stat] = await Promise.all([
		readFile(`/proc/${pid}/status`, "utf8"),
		readFile(`/proc/${pid}/stat`, "utf8"),
	]);
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const value = (name: string) =>
		Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
	return {
		rssKiB: value("VmRSS"),
		peakKiB: value("VmHWM"),
		cpuTicks: Number(fields[11]) + Number(fields[12]),
	};
}
async function postgresMemory() {
	const id = process.env.I2N_TEST_CONTAINER_ID;
	assert.ok(id, "profile requires a testcontainers-owned PostgreSQL container");
	const { stdout } = await exec("podman", ["top", id, "hpid"]);
	const pids = stdout
		.trim()
		.split("\n")
		.slice(1)
		.map((line) => Number(line.trim()));
	const samples = await Promise.all(
		pids.map((pid) => status(pid).catch(() => null)),
	);
	const live = samples.filter(Boolean);
	return {
		processes: live.length,
		sumRssKiB: live.reduce(
			(sum, sample) => sum + assertPresent(sample).rssKiB,
			0,
		),
		largestRssKiB: Math.max(
			0,
			...live.map((sample) => assertPresent(sample).rssKiB),
		),
		cpuTicks: live.reduce(
			(sum, sample) => sum + assertPresent(sample).cpuTicks,
			0,
		),
	};
}
async function signedHeaders(
	key: LoadedKey,
	method: string,
	pathname: string,
	body: Uint8Array<ArrayBuffer>,
): Promise<Record<string, string | number>> {
	return {
		"content-type": "application/msgpack",
		authorization: await authorizationHeader({
			key,
			origin,
			ts: Math.floor(Date.now() / 1000),
			nonce: freshNonce(),
			method,
			path: pathname,
			body,
		}),
	};
}
async function send(
	key: LoadedKey,
	body: Uint8Array<ArrayBuffer>,
	chunked: boolean,
	path = "/api/media",
	method = "POST",
) {
	const headers = await signedHeaders(key, method, path, body);
	if (method === "PUT") {
		headers["content-type"] = "application/octet-stream";
	}
	if (!chunked) {
		headers["content-length"] = body.length;
	}
	const response = new Promise<{
		status?: number;
		body: Buffer;
	}>((resolve, reject) => {
		const request = http.request(
			`${origin}${path}`,
			{ method, headers },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode, body: Buffer.concat(chunks) }),
				);
				res.on("error", reject);
			},
		);
		request.on("error", reject);
		(async () => {
			if (chunked) {
				for (let offset = 0; offset < body.length; offset += 16 * 1024) {
					if (!request.write(body.subarray(offset, offset + 16 * 1024))) {
						await once(request, "drain");
					}
				}
				request.end();
			} else {
				request.end(body);
			}
		})().catch(reject);
	});
	const result = await response;
	assert.ok(
		result.status === 201 || result.status === 204,
		result.body.toString(),
	);
}
async function download(key: LoadedKey, id: string, index = 0) {
	const pathname = `/api/media/${id}/chunks/${index}`;
	const headers = await signedHeaders(key, "GET", pathname, new Uint8Array());
	return new Promise<IncomingMessage>((resolve, reject) => {
		const request = http.get(
			`${origin}${pathname}`,
			{ headers },
			(response) => {
				response.pause();
				heldResponses.add(response);
				response.once("close", () => heldResponses.delete(response));
				resolve(response);
			},
		);
		request.on("error", reject);
	});
}
async function prepared(key: LoadedKey, fill: number) {
	const { descriptor, content } = await createContent(key, 32 * 1024 * 1024);
	const meta = await encrypt(
		key,
		metaAad(content.id),
		new Uint8Array(65536 - 43),
	);
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	for (let i = 0; i < content.chunks; i++) {
		chunks.push(
			await encryptChunk(content, i, new Uint8Array(CHUNK_BYTES).fill(fill)),
		);
	}
	return {
		id: content.id,
		content: chunks,
		body: encodeUpload({
			id: content.id,
			plaintext_bytes: content.size,
			descriptor,
			meta,
			tags: [],
		}),
	};
}
async function upload(
	key: LoadedKey,
	file: Awaited<ReturnType<typeof prepared>>,
	chunked: boolean,
) {
	await send(key, file.body, chunked);
	for (let i = 0; i < file.content.length; i++) {
		await send(
			key,
			file.content[i],
			chunked,
			`/api/media/${file.id}/chunks/${i}`,
			"PUT",
		);
	}
}
async function receive(
	response: IncomingMessage,
	key: LoadedKey,
	id: string,
	expected: Uint8Array<ArrayBuffer>[],
) {
	for (let index = 0; index < expected.length; index++) {
		if (index) {
			response = await download(key, id, index);
		}
		assert.equal(response.statusCode, 200);
		assert.equal(
			Number(response.headers["content-length"]),
			expected[index].length,
		);
		assert.equal(response.headers.etag, `"${id}.${index}"`);
		let offset = 0;
		for await (const chunk of response) {
			assert(
				chunk.equals(
					Buffer.from(expected[index].subarray(offset, offset + chunk.length)),
				),
			);
			offset += chunk.length;
		}
		assert.equal(offset, expected[index].length);
	}
}
async function run() {
	const databaseUrl = await fixture("create");
	let server: Awaited<ReturnType<typeof startServer>>["child"] | undefined;
	let serverError: unknown;
	let monitoring: Promise<void> | undefined;
	let healthMonitor: Promise<void> | undefined;
	let postgresMonitor: Promise<void> | undefined;
	let monitorError: unknown;
	const monitorFailure = (error: unknown) => {
		monitorError = error;

		stop = true;
	};
	let stop = false;
	try {
		const started = await startServer(databaseUrl, "release");
		server = started.child;
		origin = started.origin;
		server.on("error", (error) => {
			serverError = error;
		});
		const deadline = Date.now() + 30000;
		while (true) {
			if (serverError) {
				throw serverError;
			}
			if (server.exitCode !== null) {
				throw new Error("profile server exited during startup");
			}
			try {
				const response = await fetch(`${origin}/api/health`);
				if (response.ok) {
					await response.arrayBuffer();
					break;
				}
			} catch {}
			assert.ok(Date.now() < deadline, "profile server startup timed out");
			await delay(50);
		}
		const code = await issueOtc(databaseUrl, "release");
		const identity = await generatePrivateKey();
		const key = await loadKey(identity.privateKey);
		await registerKey({ serverUrl: origin, key, otc: code });
		const baseline = await status(server.pid);
		const postgresBaseline = await postgresMemory();
		let sampledPeakKiB = baseline.rssKiB;
		let healthPeakMs = 0;
		let healthChecks = 0;
		monitoring = (async () => {
			while (!stop) {
				sampledPeakKiB = Math.max(
					sampledPeakKiB,
					(await status(server.pid)).rssKiB,
				);
				await delay(10);
			}
		})().catch(monitorFailure);
		healthMonitor = (async () => {
			while (!stop) {
				const start = performance.now();
				const response = await fetch(`${origin}/api/health`, {
					signal: AbortSignal.timeout(5000),
				});
				assert.equal(response.status, 200);
				await response.arrayBuffer();
				healthPeakMs = Math.max(healthPeakMs, performance.now() - start);
				healthChecks++;
				await delay(20);
			}
		})().catch(monitorFailure);
		let postgresPeakSumRssKiB = postgresBaseline.sumRssKiB;
		postgresMonitor = (async () => {
			while (!stop) {
				postgresPeakSumRssKiB = Math.max(
					postgresPeakSumRssKiB,
					(await postgresMemory()).sumRssKiB,
				);
				await delay(200);
			}
		})().catch(monitorFailure);
		const rounds: Array<{
			chunked: boolean;
			elapsedMs: number;
			afterUpload: {
				rssKiB: number;
				peakKiB: number;
				cpuTicks: number;
			};
			heldDownloads: {
				rssKiB: number;
				peakKiB: number;
				cpuTicks: number;
			};
			postgres: {
				processes: number;
				sumRssKiB: number;
				largestRssKiB: number;
				cpuTicks: number;
			};
		}> = [];
		for (const chunked of [false, true]) {
			const files = await Promise.all(
				[1, 2].map((fill) => prepared(key, fill)),
			);
			const start = performance.now();
			await Promise.all(files.map((file) => upload(key, file, chunked)));
			const afterUpload = await status(server.pid);
			const responses = await Promise.all(
				files.map((file) => download(key, file.id)),
			);
			await delay(250); // Hold response readers while sampling database and app memory.
			const heldDownloads = await status(server.pid);
			const postgres = await postgresMemory();
			assert.equal(
				await fixture("inspect", databaseUrl),
				"0",
				"held downloads must not retain transactions",
			);
			await Promise.all(
				responses.map((response, index) =>
					receive(response, key, files[index].id, files[index].content),
				),
			);
			rounds.push({
				chunked,
				elapsedMs: Math.round(performance.now() - start),
				afterUpload,
				heldDownloads,
				postgres,
			});
		}
		// Saturate all sixteen download slots across eight independent owners.
		const owners = [];
		for (let i = 0; i < 8; i++) {
			const owner = await loadKey((await generatePrivateKey()).privateKey);
			await registerKey({
				serverUrl: origin,
				key: owner,
				otc: await issueOtc(databaseUrl, "release"),
			});
			const file = await prepared(owner, i);
			await upload(owner, file, false);
			owners.push({ key: owner, ...file });
		}
		const beforeDownloads = await status(server.pid);
		const saturatedStart = performance.now();
		const files = owners.flatMap((file) => [file, file]);
		const responses = await Promise.all(
			files.map((file) => download(file.key, file.id)),
		);
		await delay(250);
		const saturation = {
			beforeDownloads,
			heldDownloads: await status(server.pid),
			postgres: await postgresMemory(),
		};
		assert.equal(await fixture("inspect", databaseUrl), "0");
		await Promise.all(
			responses.map((response, i) =>
				receive(response, files[i].key, files[i].id, files[i].content),
			),
		);
		const saturatedElapsedMs = Math.round(performance.now() - saturatedStart);

		stop = true;
		await Promise.all([monitoring, healthMonitor, postgresMonitor]);
		if (monitorError) {
			throw monitorError;
		}
		monitoring = undefined;
		console.log(
			JSON.stringify(
				{
					baseline,
					sampledPeakKiB,
					final: await status(server.pid),
					healthPeakMs,
					healthChecks,
					postgresBaseline,
					postgresPeakSumRssKiB,
					clockTicksPerSecond: Number(
						(await exec("getconf", ["CLK_TCK"])).stdout.trim(),
					),
					rounds,
					saturation: {
						...saturation,
						elapsedMs: saturatedElapsedMs,
						downloads: files.length,
					},
					clientPeakKiB: process.resourceUsage().maxRSS,
				},
				null,
				2,
			),
		);
	} finally {
		stop = true;
		await Promise.allSettled(
			[monitoring, healthMonitor, postgresMonitor].filter(Boolean),
		);
		for (const response of heldResponses) {
			response.destroy();
		}
		await stopServer(server);
		await fixture("drop", databaseUrl);
	}
}
await run();
