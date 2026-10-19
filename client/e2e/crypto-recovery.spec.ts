import { readFile } from "node:fs/promises";
import {
	createLibrary,
	expect,
	master,
	recovery,
	restore,
	test,
} from "./fixtures.ts";

test("restored file and tag keys support edited metadata, search and content downloads", async ({
	page,
	app,
	browser,
}) => {
	await createLibrary(page, app);
	const manifest = await recovery(page);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const bytes = Buffer.from("Content protected by a wrapped per-upload key.\n");
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "Original.txt",
		mimeType: "text/plain",
		buffer: bytes,
	});
	const original = page.getByRole("article");
	await expect(original).toHaveCount(1);
	await original
		.getByRole("button", { name: "Edit filename Original.txt", exact: true })
		.click();
	const name = original.getByRole("textbox", {
		name: "Filename for Original.txt",
		exact: true,
	});
	await name.fill("Renamed.txt");
	await name.press("Enter");
	await original
		.getByRole("button", { name: "Add tag to Renamed.txt", exact: true })
		.click();
	const tag = original.getByRole("textbox", {
		name: "New tag for Renamed.txt",
		exact: true,
	});
	await tag.fill("Fresh");
	await tag.press("Enter");
	await expect(
		original.getByRole("button", { name: "Remove tag Fresh", exact: true }),
	).toBeVisible();

	const context = await browser.newContext();
	try {
		const restored = await context.newPage();
		await restore(restored, app, manifest);
		await restored.getByRole("link", { name: "Library", exact: true }).click();
		const search = restored.getByRole("searchbox", {
			name: "Search tags",
			exact: true,
		});
		await search.fill("Fresh");
		await search.press("Enter");
		const card = restored.getByRole("article");
		await expect(card).toHaveCount(1);
		await expect(
			card.getByRole("button", {
				name: "Edit filename Renamed.txt",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			card.getByRole("button", { name: "Remove tag Fresh", exact: true }),
		).toBeVisible();
		await restored.reload();
		await master(restored);
		await expect(card).toHaveCount(1);
		const downloading = restored.waitForEvent("download");
		await card.getByRole("button", { name: "Download", exact: true }).click();
		const download = await downloading;
		expect(download.suggestedFilename()).toBe("Renamed.txt");
		expect(await readFile(await download.path())).toEqual(bytes);
	} finally {
		await context.close();
	}
});
