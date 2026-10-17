import { readFile } from "node:fs/promises";
import { createLibrary, expect, shot, test } from "./fixtures.ts";

test("text and code previews escape markup, handle empty content and label bounded previews", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const markup =
		"<script>window.unexpectedExecution = true</script>\n<h1>Just text</h1>";
	const large = Buffer.from(`${"a".repeat(256 * 1024)}hidden tail`);
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		{
			name: "source.rs",
			mimeType: "application/octet-stream",
			buffer: Buffer.from(markup),
		},
		{ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
		{ name: "large.log", mimeType: "text/plain", buffer: large },
	]);
	await expect(page.getByRole("article")).toHaveCount(3);
	await page
		.getByRole("button", { name: "Open source.rs", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "Media preview" });
	await expect(dialog.locator("pre")).toHaveText(markup);
	await expect(dialog.locator("script, h1")).toHaveCount(0);
	expect(
		await page.evaluate(() => Reflect.get(window, "unexpectedExecution")),
	).toBeUndefined();
	for (const width of [1100, 360, 320]) {
		await page.setViewportSize({ width, height: 800 });
		await shot(page, `text-preview-${width}`);
	}
	await page
		.getByRole("button", { name: "Close preview", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Open empty.txt", exact: true })
		.click();
	await expect(dialog.locator("pre")).toBeAttached();
	await expect(dialog.locator("pre")).toHaveText("");
	await page
		.getByRole("button", { name: "Close preview", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Open large.log", exact: true })
		.click();
	await expect(
		dialog.getByText(/Preview limited to the first 256 KiB/),
	).toBeVisible();
	expect(
		await dialog.locator("pre").evaluate((node) => node.textContent.length),
	).toBe(256 * 1024);
	await page
		.getByRole("button", { name: "Close preview", exact: true })
		.click();
	const downloading = page.waitForEvent("download");
	await page
		.getByRole("article")
		.filter({
			has: page.getByRole("button", { name: "Open large.log", exact: true }),
		})
		.getByRole("button", { name: "Download", exact: true })
		.click();
	expect(await readFile(await (await downloading).path())).toEqual(large);
});
