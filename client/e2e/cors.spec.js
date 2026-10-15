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
					"content-type": "application/octet-stream",
				},
			});
			const register = await fetch(`${origin}/api/register-key`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			return {
				health: await health.json(),
				status: signed.status,
				error: await signed.json(),
				registration: register.status,
			};
		}, app.origin);
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
