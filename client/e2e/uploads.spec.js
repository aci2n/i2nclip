import { createLibrary, expect, shot, test } from "./fixtures.js";

test("per-file progress stays shared and completed history expires after five seconds", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const other = await page.context().newPage();
	await other.goto(page.url());
	await page.evaluate(() => window.serviceTest("pauseUploads"));
	try {
		await page.locator("#files").setInputFiles(
			["First long filename.txt", "Second.txt", "Third.txt"].map((name) => ({
				name,
				mimeType: "text/plain",
				buffer: Buffer.from(name),
			})),
		);
		await page.locator(".uploads summary").click();
		await other.locator(".uploads summary").click();
		await expect(page.locator(".upload-list li")).toHaveCount(3);
		await expect(other.locator(".upload-list li")).toHaveCount(3);
		await expect(page.locator(".upload-list li small")).toHaveText([
			"uploading",
			"queued",
			"queued",
		]);
		await page.setViewportSize({ width: 320, height: 800 });
		await shot(page, "uploads-progress-320");
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await page.evaluate(() => window.serviceTest("resumeUploads"));
		await expect(page.locator(".card")).toHaveCount(3);
		await expect(
			page.getByRole("button", {
				name: "Clear completed uploads",
				exact: true,
			}),
		).toBeVisible();
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.serviceTest("state"))).uploads
						.length,
				{ timeout: 10000 },
			)
			.toBe(0);
		await expect(other.locator(".uploads")).toContainText("No recent uploads.");
		await expect(other.locator(".card")).toHaveCount(3);
	} finally {
		await page.evaluate(() => window.serviceTest("resumeUploads"));
		await other.close();
	}
});
