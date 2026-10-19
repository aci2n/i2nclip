import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

test("Vite serves a classic streaming worker that registers on first visit", async ({
	page,
}) => {
	const client = fileURLToPath(new URL("../", import.meta.url));
	await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
	const cache = await mkdtemp(
		fileURLToPath(new URL("../dist/dev-server-", import.meta.url)),
	);
	let server: ViteDevServer | undefined;
	try {
		server = await createServer({
			root: client,
			cacheDir: cache,
			configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
			server: { host: "127.0.0.1", port: 0, hmr: false },
		});
		await server.listen();
		const address = server.httpServer?.address();
		if (!address || typeof address === "string") {
			throw new Error("Vite did not bind a loopback port.");
		}
		const origin = `http://127.0.0.1:${address.port}`;
		for (const method of ["GET", "HEAD"]) {
			const response = await fetch(`${origin}/streaming-worker.js`, { method });
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("javascript");
			expect(response.headers.get("cache-control")).toBe("no-cache");
			if (method === "GET") {
				expect(await response.text()).not.toContain("<!doctype html>");
			}
		}
		await page.goto(origin);
		const script = await page.evaluate(async () => {
			await navigator.serviceWorker.register("/streaming-worker.js", {
				scope: "/",
			});
			const registration = await navigator.serviceWorker.ready;
			return registration.active?.scriptURL;
		});
		expect(script).toBe(`${origin}/streaming-worker.js`);
	} finally {
		try {
			await server?.close();
		} finally {
			await rm(cache, { recursive: true, force: true });
		}
	}
});
