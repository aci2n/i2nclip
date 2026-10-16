// Explicit Linux-only resource profile; never runs as part of npm test.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import { b64urlToBytes } from "../src/lib/protocol/bytes.js";
import {
	authorizationHeader,
	bodyHash,
	contentAad,
	encrypt,
	freshNonce,
	loadKey,
	metaAad,
} from "../src/lib/protocol/crypto.js";
import { encodePost } from "../src/lib/protocol/frame.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { encode } from "../src/lib/protocol/msgpack.js";

import {
	database as fixture,
	issueOtc,
	startServer,
	stopServer,
} from "./process.js";

const exec = promisify(execFile);
let origin;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const heldResponses = new Set();

async function status(pid) {
	const [text, stat] = await Promise.all([
		readFile(`/proc/${pid}/status`, "utf8"),
		readFile(`/proc/${pid}/stat`, "utf8"),
	]);
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const value = (name) =>
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
		sumRssKiB: live.reduce((sum, sample) => sum + sample.rssKiB, 0),
		largestRssKiB: Math.max(0, ...live.map((sample) => sample.rssKiB)),
		cpuTicks: live.reduce((sum, sample) => sum + sample.cpuTicks, 0),
	};
}

async function signedHeaders(key, method, pathname, body) {
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

async function upload(key, body, chunked) {
	const headers = await signedHeaders(key, "POST", "/api/media", body);
	if (!chunked) {
		headers["content-length"] = body.length;
	}
	const response = new Promise((resolve, reject) => {
		const request = http.request(
			`${origin}/api/media`,
			{ method: "POST", headers },
			(res) => {
				const chunks = [];
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
	assert.equal(result.status, 201, result.body.toString());
}

async function download(key, id) {
	const pathname = `/api/media/${id}`;
	const headers = await signedHeaders(key, "GET", pathname, new Uint8Array());
	return new Promise((resolve, reject) => {
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

async function receive(response, id, expectedContent) {
	assert.equal(response.statusCode, 200);
	assert.equal(
		Number(response.headers["content-length"]),
		expectedContent.length,
	);
	const chunks = [];
	for await (const chunk of response) {
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	assert.equal(await bodyHash(bytes), id);
	assert.deepEqual(
		bytes,
		Buffer.from(
			expectedContent.buffer,
			expectedContent.byteOffset,
			expectedContent.byteLength,
		),
	);
}

async function run() {
	const databaseUrl = await fixture("create");
	let server;
	let serverError;
	let monitoring;
	let healthMonitor;
	let postgresMonitor;
	let monitorError;
	const monitorFailure = (error) => {
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
		const deadline = Date.now() + 30_000;
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
		const registration = await fetch(`${origin}/api/register-key`, {
			method: "POST",
			headers: { "content-type": "application/msgpack" },
			body: encode({
				otc: code,
				public_key: b64urlToBytes(identity.publicKey),
			}),
		});
		assert.equal(registration.status, 204);
		const key = await loadKey(identity.privateKey);
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
		const rounds = [];
		for (const chunked of [false, true]) {
			const files = await Promise.all(
				[1, 2].map(async (fill) => {
					const content = await encrypt(
						key,
						contentAad(),
						new Uint8Array(32 * 1024 * 1024).fill(fill),
					);
					const id = await bodyHash(content);
					const meta = await encrypt(
						key,
						metaAad(id),
						new Uint8Array(65536 - 43),
					);
					assert.equal(meta.length, 65536);
					return { content, id, body: encodePost({ meta, content, tags: [] }) };
				}),
			);
			const start = performance.now();
			await Promise.all(files.map((file) => upload(key, file.body, chunked)));
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
					receive(response, files[index].id, files[index].content),
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
