import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import http from "node:http";
import { promisify } from "node:util";
import { get } from "svelte/store";
import { authorizationHeader, freshNonce } from "../src/lib/protocol/auth.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { stateCheckpoint } from "../src/lib/stores/chain.ts";
import { liveLibrary } from "./live-library.ts";
import { database, issueOtc, startServer, stopServer } from "./process.ts";

// Explicit Linux/Podman resource profile; never part of npm test.
const execute = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function status(pid: number) {
	const text = await readFile(`/proc/${pid}/status`, "utf8");
	const value = (name: string) =>
		Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
	return { rssKiB: value("VmRSS"), peakKiB: value("VmHWM") };
}
async function postgresMemory() {
	const id = process.env.I2N_TEST_CONTAINER_ID;
	assert.ok(id, "profile requires a testcontainers-owned PostgreSQL container");
	const { stdout } = await execute("podman", ["top", id, "hpid"]);
	const samples = await Promise.all(
		stdout
			.trim()
			.split("\n")
			.slice(1)
			.map((line) => status(Number(line.trim())).catch(() => null)),
	);
	return {
		processes: samples.filter(Boolean).length,
		sumRssKiB: samples.reduce((sum, sample) => sum + (sample?.rssKiB ?? 0), 0),
	};
}
async function run() {
	const url = await database("create");
	let server: Awaited<ReturnType<typeof startServer>> | undefined;
	const clients: Array<Awaited<ReturnType<typeof liveLibrary>>> = [];
	const held = new Set<IncomingMessage>();
	let stopped = false;
	let monitoring: Promise<void> | undefined;
	let monitorError: unknown;
	try {
		server = await startServer(url, "release");
		assert.ok(server.child.pid);
		const baseline = await status(server.child.pid);
		const postgresBaseline = await postgresMemory();
		let sampledPeakKiB = baseline.rssKiB;
		let healthPeakMs = 0;
		const origin = server.origin;
		const pid = server.child.pid;
		monitoring = (async () => {
			while (!stopped) {
				sampledPeakKiB = Math.max(sampledPeakKiB, (await status(pid)).rssKiB);
				const start = performance.now();
				const response = await fetch(`${origin}/api/health`, {
					signal: AbortSignal.timeout(5000),
				});
				assert.equal(response.status, 200);
				await response.arrayBuffer();
				healthPeakMs = Math.max(healthPeakMs, performance.now() - start);
				await delay(20);
			}
		})().catch((error) => {
			monitorError = error;
		});
		const rounds = [];
		for (const chunked of [false, true]) {
			const begin = performance.now();
			const client = await liveLibrary(
				origin,
				await issueOtc(url, "release"),
				async (input, init) => {
					if (
						chunked &&
						init?.body instanceof Uint8Array &&
						new URL(String(input)).pathname === "/api/blobs"
					) {
						const options: RequestInit & { duplex: "half" } = {
							...init,
							body: new Blob([new Uint8Array(init.body)]).stream(),
							duplex: "half",
						};
						return fetch(input, options);
					}
					return fetch(input, init);
				},
			);
			clients.push(client);
			const live = get(client.chain).live;
			assert.ok(live);
			const result = await client.files.upload({
				file: new Blob([new Uint8Array(32 * 1024 * 1024).fill(7)]),
				attributes: { name: "profile.bin" },
				expected: stateCheckpoint(live),
				signal: client.signal,
			});
			const file = get(client.chain).live?.files.get(result.id);
			assert.ok(file);
			const manifest = await client.files.manifest(file, client.signal);
			// Hash-addressed chunks are immutable; hold two readers after publication.
			const hash = bytesToHex(manifest.hashes[0]);
			const path = `/api/blobs/${result.id}/${hash}`;
			const download = async () => {
				const authorization = await authorizationHeader({
					key: client.identity.signing,
					origin,
					method: "GET",
					path,
					body: new Uint8Array(),
					ts: Math.floor(Date.now() / 1000),
					nonce: freshNonce(),
				});
				return new Promise<IncomingMessage>((resolve, reject) => {
					const request = http.get(
						`${origin}${path}`,
						{ headers: { authorization } },
						(response) => {
							response.pause();
							held.add(response);
							response.once("close", () => held.delete(response));
							resolve(response);
						},
					);
					request.on("error", reject);
				});
			};
			const expected = await client.api.blob(result.id, hash, client.signal);
			const responses = await Promise.all([download(), download()]);
			await delay(250);
			const heldDownloads = await status(pid);
			assert.equal(
				await database("inspect", url),
				"0",
				"held downloads must not retain transactions",
			);
			await Promise.all(
				responses.map(async (response) => {
					assert.equal(response.statusCode, 200);
					let offset = 0;
					for await (const raw of response) {
						const bytes = Buffer.from(raw);
						assert.deepEqual(
							bytes,
							Buffer.from(expected.subarray(offset, offset + bytes.length)),
						);
						offset += bytes.length;
					}
					assert.equal(offset, expected.length);
				}),
			);
			rounds.push({
				chunked,
				elapsedMs: Math.round(performance.now() - begin),
				heldDownloads,
				postgres: await postgresMemory(),
			});
		}
		stopped = true;
		await monitoring;
		if (monitorError) {
			throw monitorError;
		}
		console.log(
			JSON.stringify(
				{
					baseline,
					postgresBaseline,
					sampledPeakKiB,
					healthPeakMs,
					rounds,
					clientPeakKiB: process.resourceUsage().maxRSS,
				},
				null,
				2,
			),
		);
	} finally {
		stopped = true;
		await monitoring;
		for (const response of held) {
			response.destroy();
		}
		for (const client of clients) {
			client.dispose();
		}
		await stopServer(server?.child);
		await database("drop", url);
	}
}
await run();
