import { readFile } from "node:fs/promises";
import { setKeyLimits } from "../tests/process.ts";
import { createLibrary, expect, master, shot, test } from "./fixtures.ts";

test("Your library shows usage, refreshes after media changes, and retries offline errors", async ({
	page,
	app,
	context,
}) => {
	await createLibrary(page, app, 10 * 1024 ** 3);
	const usage = page.getByLabel("Library usage");
	await expect(usage).toContainText("Storage: 0 B of 10.0 GB");
	await expect(usage).toContainText("Files: 0 of 10,000");
	await expect(usage).toContainText(
		"Storage includes reservations for uploads in progress.",
	);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "Notes.bin",
		mimeType: "application/octet-stream",
		buffer: Buffer.alloc(1024 * 1024, 7),
	});
	await expect(page.getByRole("article")).toHaveCount(1);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(usage).toContainText("Storage: 1.0 MB of 10.0 GB");
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
	await expect(usage).toContainText("Storage: 0 B of 10.0 GB");
	await expect(usage).toContainText("Files: 0 of 10,000");
	expect(await page.locator("[id]").count()).toBe(0);
});

test("files above 32 MiB stream through library and deeplink downloads after quota is reduced", async ({
	page,
	app,
}) => {
	await createLibrary(page, app, 128 * 1024 * 1024);
	const key = (await page.locator("code").first().innerText()).trim();
	expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
	await expect(page.getByLabel("Library usage")).toContainText(
		"Storage: 0 B of 128.0 MB",
	);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const quota = page.waitForResponse(
		(response) => response.url().endsWith("/api/quota") && response.ok(),
	);
	await page.reload();
	await master(page);
	await quota;
	const bytes = Buffer.alloc(32 * 1024 * 1024 + 1, 7);
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "Above the former fixed limit.bin",
		mimeType: "application/octet-stream",
		buffer: bytes,
	});
	const card = page.getByRole("article");
	await expect(card).toHaveCount(1);
	await setKeyLimits(app.data, key, {
		maxBytes: 32 * 1024 * 1024 + 1 + 9 * 16 + 17,
		maxFiles: 10000,
	});
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(page.getByLabel("Library usage")).toContainText(
		"Files: 1 of 10,000",
	);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect((await readFile(await download.path())).equals(bytes)).toBe(true);
	const opened = page.waitForEvent("popup");
	await card
		.getByRole("link", {
			name: "Link to Above the former fixed limit.bin",
			exact: true,
		})
		.click();
	const linked = await opened;
	try {
		await expect(
			linked.getByRole("heading", {
				name: "Above the former fixed limit.bin",
				exact: true,
			}),
		).toBeVisible();
		const linkedDownloading = linked.waitForEvent("download");
		await linked.getByRole("button", { name: "Download", exact: true }).click();
		expect(
			(await readFile(await (await linkedDownloading).path())).equals(bytes),
		).toBe(true);
	} finally {
		await linked.close();
	}
	// The remaining quota admits a one-byte file plus its GCM tag.
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		{
			name: "Too large.bin",
			mimeType: "application/octet-stream",
			buffer: Buffer.alloc(2),
		},
		{
			name: "Exact limit.bin",
			mimeType: "application/octet-stream",
			buffer: Buffer.alloc(1),
		},
	]);
	await expect(
		page.getByText("Library storage limit reached.", { exact: false }),
	).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(2);
});
