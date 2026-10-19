import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { build } from "vite";
import { buildStreamingWorker } from "../streaming.config.ts";
import { database, root, startServer, stopServer } from "../tests/process.ts";
import type {} from "./streaming-proof/main.ts";

const test = base.extend<{ streamingOrigin: string }>({
	streamingOrigin: async ({ page }, use) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await mkdir(path.join(root, "client/dist"), { recursive: true });
		const directory = await mkdtemp(
			path.join(root, "client/dist/streaming-proof-"),
		);
		let data: string | undefined;
		let server: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			await build({
				configFile: false,
				root: path.join(root, "client/e2e/streaming-proof"),
				publicDir: false,
				logLevel: "error",
				build: {
					outDir: directory,
					emptyOutDir: true,
					minify: false,
				},
			});
			await buildStreamingWorker(directory);
			data = await database("create");
			server = await startServer(data, "debug", directory);
			await use(server.origin);
			expect(errors).toEqual([]);
		} finally {
			try {
				await stopServer(server?.child);
			} finally {
				try {
					if (data) {
						await database("drop", data);
					}
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			}
		}
	},
});

test("first-visit byte ranges, empty files and token isolation", async ({
	page,
	context,
	streamingOrigin,
}) => {
	await page.goto(streamingOrigin);
	await page.waitForFunction(() => Boolean(window.streamingProof));
	const result = await page.evaluate(async () => {
		const source = await window.streamingProof.generated(2 ** 33 + 123);
		const ranges = [];
		for (const range of [
			"bytes=4294967296-4294967300",
			"bytes=-9",
			"bytes=8589934715-",
			"bytes=0-1,4-5",
		]) {
			// Never consume the intentionally enormous full response for multipart.
			const response = await fetch(source.url, { headers: { range } });
			const bytes =
				response.status === 206
					? Array.from(new Uint8Array(await response.arrayBuffer()))
					: [];
			await response.body?.cancel().catch(() => {});
			ranges.push({
				status: response.status,
				contentRange: response.headers.get("content-range"),
				cache: response.headers.get("cache-control"),
				bytes,
			});
		}
		const empty = await window.streamingProof.generated(0);
		const response = await fetch(empty.url);
		const head = await fetch(source.url, { method: "HEAD" });
		return {
			source,
			ranges,
			empty: {
				status: response.status,
				length: (await response.arrayBuffer()).byteLength,
			},
			head: {
				status: head.status,
				bytes: (await head.arrayBuffer()).byteLength,
				length: head.headers.get("content-length"),
			},
		};
	});
	expect(result.ranges.map((entry) => entry.status)).toEqual([
		206, 206, 416, 200,
	]);
	expect(result.ranges[0].bytes).toEqual(
		Array.from({ length: 5 }, (_, index) => (4294967296 + index) % 251),
	);
	expect(result.ranges[1].bytes).toEqual(
		Array.from({ length: 9 }, (_, index) => (2 ** 33 + 114 + index) % 251),
	);
	expect(result.ranges[2].contentRange).toBe("bytes */8589934715");
	expect(result.ranges.every((entry) => entry.cache === "no-store")).toBe(true);
	expect(result.empty).toEqual({ status: 200, length: 0 });
	expect(result.head).toEqual({ status: 200, bytes: 0, length: "8589934715" });
	const other = await context.newPage();
	try {
		await other.goto(streamingOrigin);
		await other.waitForFunction(() => Boolean(window.streamingProof));
		const status = await other.evaluate(async (url) => {
			const own = await window.streamingProof.generated(1);
			const token = url.split("/").at(-2);
			const foreign = own.url.replace(/[^/]+\/inline$/, `${token}/inline`);
			return (await fetch(foreign)).status;
		}, result.source.url);
		expect(status).toBe(503);
	} finally {
		await other.close();
	}
});

test("native download larger than 1 GiB preserves every byte with bounded reads", async ({
	page,
	streamingOrigin,
}) => {
	test.setTimeout(300_000);
	await page.goto(streamingOrigin);
	await page.waitForFunction(() => Boolean(window.streamingProof));
	const size = 1024 ** 3 + 123;
	const source = await page.evaluate(
		(size) => window.streamingProof.generated(size),
		size,
	);
	const downloading = page.waitForEvent("download");
	await page.evaluate(
		(key) => window.streamingProof.beginDownload(key),
		source.key,
	);
	await page.getByRole("link", { name: "Download generated file" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("Generated file.bin");
	const failure = await download.failure();
	expect(
		failure,
		JSON.stringify(await page.evaluate(() => window.streamingProof.metrics)),
	).toBeNull();
	const filename = await download.path();
	assert(filename);
	let offset = 0;
	for await (const chunk of createReadStream(filename)) {
		const bytes = chunk as Buffer;
		for (let index = 0; index < bytes.length; index++) {
			if (bytes[index] !== (offset + index) % 251) {
				assert.fail(`Wrong byte at ${offset + index}`);
			}
		}
		offset += bytes.length;
	}
	expect(offset).toBe(size);
	await page.evaluate(() => window.streamingProof.downloadDone());
	const metrics = await page.evaluate(() => window.streamingProof.metrics);
	expect(metrics.maximumRead).toBeLessThanOrEqual(4 * 1024 * 1024);
	expect(metrics.maximumActive).toBe(1);
	expect(metrics.reads.length).toBe(Math.ceil(size / (4 * 1024 * 1024)));
});

test("bounded range responses, two-read admission and disposal cancel pending reads", async ({
	page,
	streamingOrigin,
}) => {
	await page.goto(streamingOrigin);
	await page.waitForFunction(() => Boolean(window.streamingProof));
	const result = await page.evaluate(async () => {
		const source = await window.streamingProof.generated(1024 ** 3, 500);
		const response = await fetch(source.url, {
			headers: { range: "bytes=0-" },
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		const unconsumedReads = [window.streamingProof.metrics.reads.length];
		await new Promise((resolve) => setTimeout(resolve, 1500));
		unconsumedReads.push(window.streamingProof.metrics.reads.length);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		unconsumedReads.push(window.streamingProof.metrics.reads.length);
		await response.body?.cancel();
		const controllers = Array.from({ length: 5 }, () => new AbortController());
		const reading = controllers.map(async (controller) => {
			try {
				const response = await fetch(source.url, { signal: controller.signal });
				const reader = response.body?.getReader();
				await reader?.read();
				await reader?.cancel();
			} catch {
				/* Expected cancellation. */
			}
		});
		const deadline = performance.now() + 5000;
		while (window.streamingProof.metrics.active < 2) {
			if (performance.now() > deadline) {
				throw new Error("Concurrent source reads did not start.");
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		window.streamingProof.dispose(source.key);
		for (const controller of controllers) {
			controller.abort();
		}
		await Promise.all(reading);
		await new Promise((resolve) => setTimeout(resolve, 100));
		return { unconsumedReads, ...window.streamingProof.metrics };
	});
	expect(result.unconsumedReads, JSON.stringify(result)).toEqual([1, 1, 1]);
	expect(result.maximumActive).toBe(2);
	expect(result.active).toBe(0);
	expect(result.aborted).toBeGreaterThan(0);
});

test("native video plays and seeks through the same virtual URL", async ({
	page,
	streamingOrigin,
}) => {
	await page.goto(streamingOrigin);
	await page.waitForFunction(() => Boolean(window.streamingProof));
	await page.evaluate(() => window.streamingProof.video());
	await page.locator("video").evaluate(async (element) => {
		const video = element as HTMLVideoElement;
		await video.play();
	});
	await expect
		.poll(() =>
			page
				.locator("video")
				.evaluate((element) => (element as HTMLVideoElement).currentTime),
		)
		.toBeGreaterThan(0);
	await page.locator("video").evaluate((element) => {
		const video = element as HTMLVideoElement;
		video.pause();
		video.currentTime = video.duration * 0.7;
	});
	await expect
		.poll(() =>
			page.locator("video").evaluate((element) => {
				const video = element as HTMLVideoElement;
				return !video.seeking && video.currentTime >= video.duration * 0.65;
			}),
		)
		.toBe(true);
	await page.evaluate(() => window.streamingProof.lock());
});

test("gigabyte audio loads metadata and seeks without draining the file", async ({
	page,
	streamingOrigin,
}) => {
	await page.goto(streamingOrigin);
	await page.waitForFunction(() => Boolean(window.streamingProof));
	const size = 1024 ** 3 + 44;
	await page.evaluate((size) => window.streamingProof.audio(size), size);
	await expect
		.poll(() =>
			page
				.locator("audio")
				.evaluate((element) => (element as HTMLAudioElement).readyState),
		)
		.toBeGreaterThanOrEqual(1);
	await page.locator("audio").evaluate((element) => {
		const audio = element as HTMLAudioElement;
		audio.currentTime = audio.duration * 0.7;
	});
	await expect
		.poll(() =>
			page.locator("audio").evaluate((element) => {
				const audio = element as HTMLAudioElement;
				return !audio.seeking && audio.currentTime >= audio.duration * 0.65;
			}),
		)
		.toBe(true);
	const metrics = await page.evaluate(() => window.streamingProof.metrics);
	expect(metrics.reads.some((read) => read.start > size / 2)).toBe(true);
	expect(
		metrics.reads.reduce((sum, read) => sum + read.end - read.start, 0),
	).toBeLessThan(size / 8);
	expect(metrics.maximumRead).toBeLessThanOrEqual(4 * 1024 * 1024);
	await page.evaluate(() => window.streamingProof.lock());
});

test("locking aborts active content and rejects new streaming sessions", async ({
	page,
	streamingOrigin,
}) => {
	await page.goto(streamingOrigin);
	await page.waitForFunction(() => Boolean(window.streamingProof));
	const source = await page.evaluate(() =>
		window.streamingProof.generated(32 * 1024 * 1024, 500),
	);
	const reading = page.evaluate(async (url) => {
		try {
			const response = await fetch(url, { headers: { range: "bytes=0-" } });
			await response.arrayBuffer();
			return false;
		} catch {
			return true;
		}
	}, source.url);
	await expect
		.poll(() => page.evaluate(() => window.streamingProof.metrics.active))
		.toBe(1);
	await page.evaluate(() => window.streamingProof.lock());
	expect(await reading).toBe(true);
	await expect
		.poll(() => page.evaluate(() => window.streamingProof.metrics.active))
		.toBe(0);
	expect(
		await page.evaluate(async () => {
			try {
				await window.streamingProof.generated(1);
				return false;
			} catch {
				return true;
			}
		}),
	).toBe(true);
});

test("fresh worker instances retain virtual URLs while closing the owning tab ends access", async ({
	page,
	context,
	browserName,
	streamingOrigin,
}) => {
	await page.goto(streamingOrigin);
	await page.waitForFunction(() => Boolean(window.streamingProof));
	const source = await page.evaluate(() =>
		window.streamingProof.generated(2 ** 33),
	);
	if (browserName === "chromium") {
		const protocol = await context.newCDPSession(page);
		await protocol.send("ServiceWorker.enable");
		await protocol.send("ServiceWorker.stopAllWorkers");
		await protocol.detach();
	} else {
		await page.evaluate(async () => {
			const registration = await navigator.serviceWorker.getRegistration();
			await registration?.unregister();
			await navigator.serviceWorker.register(
				`/streaming-worker.js?instance=${crypto.randomUUID()}`,
				{ scope: "/" },
			);
		});
		await page.waitForFunction(() =>
			navigator.serviceWorker.controller?.scriptURL.includes("?instance="),
		);
	}
	const bytes = await page.evaluate(
		async (url) =>
			Array.from(
				new Uint8Array(
					await (
						await fetch(url, {
							headers: { range: "bytes=4294967296-4294967300" },
						})
					).arrayBuffer(),
				),
			),
		source.url,
	);
	expect(bytes).toEqual(
		Array.from({ length: 5 }, (_, i) => (2 ** 32 + i) % 251),
	);
	const remaining = await context.newPage();
	try {
		await remaining.goto(streamingOrigin);
		await remaining.waitForFunction(() => Boolean(window.streamingProof));
		await remaining.evaluate(() => window.streamingProof.generated(1));
		await page.close();
		expect(
			await remaining.evaluate(
				async (url) =>
					(await fetch(url, { headers: { range: "bytes=0-0" } })).status,
				source.url,
			),
		).toBe(404);
	} finally {
		await remaining.close();
	}
});
