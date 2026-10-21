import { readFile } from "node:fs/promises";
import { deferred } from "../tests/helpers.ts";
import {
	createLibrary,
	expect,
	imageFixture,
	master,
	openUploadPreferences,
	shot,
	test,
} from "./fixtures.ts";

test("default compression updates saved format and device preference preserves originals", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await openUploadPreferences(page);
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
	await expect(card.locator(".tag-text")).toHaveText([
		"image",
		"webp",
		"landscape",
	]);
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
	await openUploadPreferences(page);
	await setting.uncheck();
	await expect(setting).toBeEnabled();
	await page.reload();
	await master(page);
	await openUploadPreferences(page);
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
	await expect(original.locator(".tag-text")).toHaveText([
		"image",
		"png",
		"landscape",
	]);
	const savingOriginal = page.waitForEvent("download");
	await original.getByRole("button", { name: "Download", exact: true }).click();
	expect(await readFile(await (await savingOriginal).path())).toEqual(
		image.buffer,
	);
});

test("BMP uploads convert to a smaller WebP without resizing", async ({
	page,
	app,
}) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await createLibrary(page, app);
	await shot(page, "bmp-upload-settings");
	const width = 320;
	const height = 240;
	const stride = Math.ceil((width * 3) / 4) * 4;
	const bmp = Buffer.alloc(54 + stride * height);
	bmp.write("BM");
	bmp.writeUInt32LE(bmp.length, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt32LE(40, 14);
	bmp.writeInt32LE(width, 18);
	bmp.writeInt32LE(height, 22);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	bmp.writeUInt32LE(stride * height, 34);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = 54 + y * stride + x * 3;
			bmp[offset] = 120;
			bmp[offset + 1] = Math.round((y * 255) / height);
			bmp[offset + 2] = Math.round((x * 255) / width);
		}
	}
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "Gradient.bmp",
		mimeType: "image/bmp",
		buffer: bmp,
	});
	const card = page.getByRole("article");
	await expect(
		card.getByRole("button", { name: "Open Gradient.webp", exact: true }),
	).toBeVisible();
	await card.getByText("File details", { exact: true }).click();
	await expect(card.getByText("320 × 240", { exact: true })).toBeVisible();
	await expect(card.getByText("image/webp", { exact: true })).toBeVisible();
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("Gradient.webp");
	const bytes = await readFile(await download.path());
	expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
	expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
	expect(bytes.length).toBeLessThan(bmp.length);
});

test("oversized images can encode below quota and progress uses the converted filename", async ({
	page,
	app,
}) => {
	await createLibrary(page, app, 10000);
	await expect(
		page.getByRole("region", { name: "Library usage" }),
	).toContainText("Storage: 0 B of 9.8 KB");
	const image = await imageFixture(page, "Quota image.png", 1920, 1080);
	expect(image.buffer.length).toBeGreaterThan(10000);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const held = deferred();
	const started = deferred();
	await page.route("**/api/blobs", async (route) => {
		if (route.request().method() === "POST") {
			started.resolve();
			await held.promise;
		}
		await route.continue().catch(() => {});
	});
	try {
		await page.getByLabel("Upload", { exact: true }).setInputFiles(image);
		await started.promise;
		const uploads = page.getByRole("region", { name: "Uploads", exact: true });
		await expect(uploads).toContainText("Quota image.webp");
		held.resolve();
		await expect(
			page.getByRole("button", { name: "Open Quota image.webp", exact: true }),
		).toBeVisible();
		await uploads.getByText("1 file uploaded", { exact: true }).click();
		await expect(
			uploads.getByText("Quota image.webp", { exact: true }),
		).toBeVisible();
	} finally {
		held.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});
