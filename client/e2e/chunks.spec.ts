import { getMedia, registerKey, upload } from "../src/lib/api.ts";
import {
	authorizationHeader,
	freshNonce,
	loadKey,
} from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { startServer, stopServer } from "../tests/process.ts";
import { expect, issueOtc, test } from "./fixtures.ts";

for (const crossOrigin of [false, true]) {
	test(`stable chunk URLs preserve HTTP cache reuse offline (${crossOrigin ? "cross" : "same"} origin)`, async ({
		page,
		app,
		context,
	}) => {
		const key = await loadKey((await generatePrivateKey()).privateKey);
		await registerKey({
			serverUrl: app.origin,
			key,
			otc: await issueOtc(app.data),
		});
		const saved = await upload({
			serverUrl: app.origin,
			key,
			name: "cache.bin",
			file: new Blob([new Uint8Array(4 * 1024 * 1024 + 17).fill(7)]),
		});
		const media = await getMedia({ serverUrl: app.origin, key, id: saved.id });
		const separate = crossOrigin ? await startServer(app.data) : undefined;
		try {
			await page.goto(separate?.origin ?? app.origin);
			async function fetchChunks() {
				const requests = await Promise.all(
					[0, 1].map(async (index) => {
						const path = `/api/media/${saved.id}/chunks/${index}`;
						return {
							url: `${app.origin}${path}`,
							authorization: await authorizationHeader({
								key,
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
				return page.evaluate(
					async ({ requests, total }) => {
						const assembled = new Uint8Array(total);
						let offset = 0;
						const headers = [];
						for (const request of requests) {
							const response = await fetch(request.url, {
								headers: { authorization: request.authorization },
							});
							if (response.status !== 200) {
								throw new Error(`HTTP ${response.status}`);
							}
							headers.push({
								etag: response.headers.get("etag"),
								cache: response.headers.get("cache-control"),
							});
							const bytes = new Uint8Array(await response.arrayBuffer());
							assembled.set(bytes, offset);
							offset += bytes.length;
						}
						if (offset !== total) {
							throw new Error("short download");
						}
						const hash = [
							...new Uint8Array(
								await crypto.subtle.digest("SHA-256", assembled),
							),
						]
							.map((byte) => byte.toString(16).padStart(2, "0"))
							.join("");
						return { hash, headers };
					},
					{ requests, total: media.bytes },
				);
			}
			const first = await fetchChunks();
			expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
			expect(first.headers).toEqual(
				[0, 1].map((index) => ({
					etag: `"${saved.id}.${index}"`,
					cache: "private, max-age=31536000, immutable",
				})),
			);
			await context.setOffline(true);
			expect(await fetchChunks()).toEqual(first);
		} finally {
			await context.setOffline(false);
			await stopServer(separate?.child);
		}
	});
}
