import { decode } from "../src/lib/protocol/msgpack.js";
import { startServer, stopServer } from "../tests/process.js";
import { expect, test } from "./fixtures.js";

test("clients on another origin can read API success and authentication errors", async ({
	page,
	app,
}) => {
	const client = await startServer(app.data);
	try {
		await page.goto(client.origin);
		const result = await page.evaluate(async (origin) => {
			const health = await fetch(`${origin}/api/health`);
			// Authorization and Content-Type require a browser-managed preflight.
			const signed = await fetch(`${origin}/api/media`, {
				headers: {
					authorization: "Bearer invalid",
					"content-type": "application/msgpack",
				},
			});
			const register = await fetch(`${origin}/api/register-key`, {
				method: "POST",
				headers: { "content-type": "application/msgpack" },
				body: new Uint8Array([0x80]),
			});
			return {
				health: [...new Uint8Array(await health.arrayBuffer())],
				status: signed.status,
				error: [...new Uint8Array(await signed.arrayBuffer())],
				registration: register.status,
			};
		}, app.origin);
		result.health = decode(new Uint8Array(result.health));
		result.error = decode(new Uint8Array(result.error));
		expect(result).toEqual({
			health: { ok: true },
			status: 401,
			error: { error: "unauthorized" },
			registration: 400,
		});
	} finally {
		await stopServer(client.child);
	}
});
