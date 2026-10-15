import { readFile } from "node:fs/promises";
import {
	createLibrary,
	expect,
	imageFixture,
	master,
	test,
} from "./fixtures.js";

test("default compression updates saved format and device preference preserves originals", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const setting = page.getByRole("checkbox", {
		name: "Compress images to WebP",
	});
	await expect(setting).toBeChecked();
	const image = await imageFixture(page, "Landscape.png", 1920, 1080);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(image);
	const card = page.getByRole("article");
	await expect(
		card.getByRole("button", { name: "Open Landscape.webp", exact: true }),
	).toBeVisible();
	await card.getByText("File details", { exact: true }).click();
	await expect(card.getByText("image/webp", { exact: true })).toBeVisible();
	await expect(card.getByText("1920 × 1080", { exact: true })).toBeVisible();
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("Landscape.webp");
	const bytes = await readFile(await download.path());
	expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
	expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
	expect(bytes.length).toBeLessThan(image.buffer.length);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await setting.uncheck();
	await page.reload();
	await master(page);
	await expect(setting).not.toBeChecked();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(image);
	const original = page.getByRole("article").filter({
		has: page.getByRole("button", {
			name: "Open Landscape.png",
			exact: true,
		}),
	});
	await expect(original).toBeVisible();
	const savingOriginal = page.waitForEvent("download");
	await original.getByRole("button", { name: "Download", exact: true }).click();
	expect(await readFile(await (await savingOriginal).path())).toEqual(
		image.buffer,
	);
});
