import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "../tests/process.ts";
import { createLibrary, expect, test } from "./fixtures.ts";

async function digest(filename: string) {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(filename)) {
		hash.update(bytes);
	}
	return hash.digest("hex");
}

// Linux resource evidence; other supported systems still run byte verification.
async function processTreeRss(pid: number): Promise<number> {
	const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
	const children = await readFile(
		`/proc/${pid}/task/${pid}/children`,
		"utf8",
	).catch(() => "");
	const own = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0);
	const descendants = await Promise.all(
		children
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((child) => processTreeRss(Number(child))),
	);
	return own + descendants.reduce((sum, rss) => sum + rss, 0);
}
async function resourceSample() {
	if (process.platform !== "linux") {
		return null;
	}
	const children = (
		await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")
	)
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(Number);
	let browserKiB = 0;
	let serverKiB = 0;
	for (const pid of children) {
		const name = await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "");
		if (/firefox|headless_shell|chrome/.test(name)) {
			browserKiB += await processTreeRss(pid);
		}
		if (name.trim() === "test-server") {
			serverKiB += await processTreeRss(pid);
		}
	}
	return { browserKiB, serverKiB };
}

test("encrypted multi-chunk upload and native download survive view navigation", async ({
	page,
	app,
}, info) => {
	await mkdir(path.join(root, "client/dist"), { recursive: true });
	const directory = await mkdtemp(path.join(root, "client/dist/large-files-"));
	let monitor: Promise<void> | undefined;
	const monitoring = new AbortController();
	try {
		const filename = path.join(directory, "Large.bin");
		const file = await open(filename, "w");
		// Sixteen full 4 MiB chunks and a partial one, above the 32 MiB preprocessing
		// cutoff. Larger offsets are covered by generated sources in streaming.spec.ts.
		const size = 64 * 1024 ** 2 + 123;
		try {
			const block = Buffer.alloc(1024 * 1024);
			for (let i = 0; i < block.length; i++) {
				block[i] = i % 251;
			}
			for (let offset = 0; offset < size; ) {
				const { bytesWritten } = await file.write(
					block.subarray(0, Math.min(block.length, size - offset)),
				);
				offset += bytesWritten;
			}
		} finally {
			await file.close();
		}
		const expected = await digest(filename);
		await createLibrary(page, app, 128 * 1024 ** 2);
		await page.getByRole("link", { name: "Library", exact: true }).click();
		const baseline = await resourceSample();
		const peak = { browserKiB: 0, serverKiB: 0 };
		monitor = (async () => {
			while (!monitoring.signal.aborted) {
				const sample = await resourceSample();
				if (sample) {
					peak.browserKiB = Math.max(peak.browserKiB, sample.browserKiB);
					peak.serverKiB = Math.max(peak.serverKiB, sample.serverKiB);
				}
				await delay(500, undefined, { signal: monitoring.signal }).catch(
					() => {},
				);
			}
		})();
		void monitor.catch(() => {});
		// Do not subscribe to upload request bodies: the browser automation protocol
		// can copy ciphertext into the test runner independently of app memory.
		await page.getByLabel("Upload", { exact: true }).setInputFiles(filename);
		const card = page.getByRole("article");
		await expect(card).toHaveCount(1, { timeout: 60_000 });
		await expect(page.getByText(/Uploading original file/)).toBeVisible();
		// Hold the second content chunk until navigation so the transfer is still
		// in progress when the view changes. Routing continues without copying bodies.
		const navigated = Promise.withResolvers<void>();
		let chunkReads = 0;
		await page.route(
			/\/api\/blobs\/[0-9a-f]{64}\/[0-9a-f]{64}$/,
			async (route) => {
				if (route.request().method() === "GET" && ++chunkReads === 2) {
					await navigated.promise;
				}
				await route.continue();
			},
		);
		const saving = page.waitForEvent("download");
		const reading = page.waitForRequest(
			(request) =>
				request.method() === "GET" &&
				/\/api\/blobs\/[0-9a-f]{64}\/[0-9a-f]{64}$/.test(
					new URL(request.url()).pathname,
				),
		);
		await card.getByRole("button", { name: "Download", exact: true }).click();
		const download = await saving;
		await reading;
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		navigated.resolve();
		expect(await download.failure()).toBeNull();
		const saved = await download.path();
		if (!saved) {
			throw new Error("Missing native download.");
		}
		expect((await stat(saved)).size).toBe(size);
		expect(await digest(saved)).toBe(expected);
		await info.attach("transfer-resources", {
			body: JSON.stringify({ size, baseline, peak }),
			contentType: "application/json",
		});
		await expect(page.getByLabel("Library usage")).toContainText(
			"Retained files: 1 of 10000",
		);
	} finally {
		monitoring.abort();
		try {
			await monitor;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});
