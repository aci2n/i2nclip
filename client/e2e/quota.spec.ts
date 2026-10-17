import { createLibrary, expect, shot, test } from "./fixtures.ts";

test("Your library shows usage, refreshes after media changes, and retries offline errors", async ({
	page,
	app,
	context,
}) => {
	await createLibrary(page, app);
	const usage = page.getByLabel("Library usage");
	await expect(usage).toContainText("Storage: 0 B of 512.0 MB");
	await expect(usage).toContainText("Files: 0 of 10,000");
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "Notes.bin",
		mimeType: "application/octet-stream",
		buffer: Buffer.alloc(1024 * 1024, 7),
	});
	await expect(page.getByRole("article")).toHaveCount(1);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(usage).toContainText("Storage: 1.0 MB of 512.0 MB");
	await expect(usage).toContainText("Files: 1 of 10,000");
	await shot(page, "quota-desktop");
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await shot(page, `quota-${width}`);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	}
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await context.setOffline(true);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(usage.getByRole("alert")).toBeVisible();
	await shot(page, "quota-offline-360");
	await context.setOffline(false);
	await usage.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(usage).toContainText("Files: 1 of 10,000");
	await page.getByRole("link", { name: "Library", exact: true }).click();
	page.once("dialog", (dialog) => dialog.accept());
	await page
		.getByRole("article")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect(page.getByRole("article")).toHaveClass(/deleted/);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(usage).toContainText("Storage: 0 B of 512.0 MB");
	await expect(usage).toContainText("Files: 0 of 10,000");
	expect(await page.locator("[id]").count()).toBe(0);
});
