import { readFile } from "node:fs/promises";
import {
	createLibrary,
	expect,
	imageFixture,
	master,
	shot,
	test,
} from "./fixtures.ts";

test("default compression updates saved format and device preference preserves originals", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const setting = page.getByRole("checkbox", {
		name: "Convert image",
	});
	await expect(setting).toBeChecked();
	const image = await imageFixture(page, "Landscape.png", 1920, 1080);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(image);
	await page.getByRole("button", { name: "Start upload", exact: true }).click();
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
	await setting.uncheck();
	await page.reload();
	await master(page);
	await expect(setting).not.toBeChecked();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(image);
	await page.getByRole("button", { name: "Start upload", exact: true }).click();
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
	await page.getByRole("button", { name: "Start upload", exact: true }).click();
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

test("per-file formats and bounds stay independent across navigation and default changes", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByLabel("Output format", { exact: true }).selectOption("jpeg");
	await page.getByLabel("Quality (0–100)", { exact: true }).fill("72");
	await page.getByLabel("Maximum width (px)", { exact: true }).fill("800");
	await page.getByRole("heading", { name: "Images", exact: true }).click();
	const images = [
		await imageFixture(page, "Landscape for PNG.png", 1920, 1080),
		await imageFixture(page, "Portrait for JPEG.png", 1080, 1920),
	];
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(images);
	const review = page.getByRole("region", { name: "Review uploads" });
	const first = review.getByRole("article").nth(0);
	const second = review.getByRole("article").nth(1);
	await first.getByText("Upload options", { exact: true }).click();
	await first.getByLabel("Output format", { exact: true }).selectOption("png");
	await expect(
		first.getByLabel("Quality (0–100)", { exact: true }),
	).toHaveCount(0);
	await first.getByLabel("Maximum width (px)", { exact: true }).fill("400");
	await second.getByText("Upload options", { exact: true }).click();
	await expect(second.getByLabel("Output format", { exact: true })).toHaveValue(
		"jpeg",
	);
	await expect(
		second.getByLabel("Maximum width (px)", { exact: true }),
	).toHaveValue("800");
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
			await shot(page, `upload-options-${width}-${colorScheme}`);
		}
	}
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.getByLabel("Maximum width (px)", { exact: true }).fill("600");
	await page.getByRole("heading", { name: "Images", exact: true }).click();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await second.getByText("Upload options", { exact: true }).click();
	await expect(
		second.getByLabel("Maximum width (px)", { exact: true }),
	).toHaveValue("800");
	await second
		.getByRole("button", { name: "Use defaults", exact: true })
		.click();
	await expect(
		second.getByLabel("Maximum width (px)", { exact: true }),
	).toHaveValue("600");
	await first.getByText("Upload options", { exact: true }).click();
	await expect(first.getByLabel("Output format", { exact: true })).toHaveValue(
		"png",
	);
	await expect(
		first.getByLabel("Maximum width (px)", { exact: true }),
	).toHaveValue("400");
	await review
		.getByRole("button", { name: "Start upload", exact: true })
		.click();
	await expect(review).toHaveCount(0);
	for (const [name, type, dimensions] of [
		["Landscape for PNG.png", "image/png", "400 × 225"],
		["Portrait for JPEG.jpg", "image/jpeg", "600 × 1066"],
	]) {
		const card = page.getByRole("article").filter({
			has: page.getByRole("button", { name: `Open ${name}`, exact: true }),
		});
		await expect(card).toBeVisible();
		await card.getByText("File details", { exact: true }).click();
		await expect(card.getByText(type, { exact: true })).toBeVisible();
		await expect(card.getByText(dimensions, { exact: true })).toBeVisible();
	}
});
