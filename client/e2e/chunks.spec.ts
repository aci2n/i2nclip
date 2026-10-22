import { get } from "svelte/store";
import { authorizationHeader, freshNonce } from "../src/lib/protocol/auth.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { liveLibrary } from "../tests/live-library.ts";
import { startServer, stopServer } from "../tests/process.ts";
import { expect, issueOtc, test } from "./fixtures.ts";

for (const crossOrigin of [false, true]) {
	test(`ciphertext hash URLs preserve HTTP cache reuse offline (${crossOrigin ? "cross" : "same"} origin)`, async ({
		page,
		app,
		context,
	}) => {
		const client = await liveLibrary(app.origin, await issueOtc(app.data));
		const separate = crossOrigin ? await startServer(app.data) : undefined;
		try {
			const state = get(client.chain).live;
			if (!state) {
				throw new Error("Expected verified genesis");
			}
			const saved = await client.files.upload({
				file: new Blob([new Uint8Array(4 * 1024 * 1024 + 17).fill(7)]),
				attributes: { name: "cache.bin" },
				signal: client.signal,
			});
			const file = get(client.chain).live?.files.get(saved.id);
			if (!file) {
				throw new Error("Expected published file");
			}
			const manifest = await client.files.manifest(file, client.signal);
			await page.goto(separate?.origin ?? app.origin);
			async function fetchChunks() {
				const requests = await Promise.all(
					manifest.hashes.map(async (hash) => {
						const path = `/api/blobs/${saved.id}/${bytesToHex(hash)}`;
						return {
							url: `${app.origin}${path}`,
							authorization: await authorizationHeader({
								key: client.identity.signing,
								origin: app.origin,
								method: "GET",
								path,
								body: new Uint8Array(),
								ts: Math.floor(Date.now() / 1000),
								nonce: freshNonce(),
							}),
						};
					}),
				);
				return page.evaluate(async (requests) => {
					const results = [];
					for (const request of requests) {
						const response = await fetch(request.url, {
							headers: { authorization: request.authorization },
						});
						if (!response.ok) {
							throw new Error(`HTTP ${response.status}`);
						}
						const bytes = await response.arrayBuffer();
						results.push({
							length: bytes.byteLength,
							etag: response.headers.get("etag"),
							cache: response.headers.get("cache-control"),
							hash: Array.from(
								new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
								(n) => n.toString(16).padStart(2, "0"),
							).join(""),
						});
					}
					return results;
				}, requests);
			}
			const first = await fetchChunks();
			expect(first.map((chunk) => chunk.hash)).toEqual(
				manifest.hashes.map(bytesToHex),
			);
			expect(first.map((chunk) => chunk.etag)).toEqual(
				manifest.hashes.map(() => null),
			);
			expect(
				first.every(
					(chunk) => chunk.cache === "private, max-age=31536000, immutable",
				),
			).toBe(true);
			await context.setOffline(true);
			expect(await fetchChunks()).toEqual(first);
		} finally {
			await context.setOffline(false);
			client.dispose();
			await stopServer(separate?.child);
		}
	});
}
