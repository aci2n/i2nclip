import { readFile } from "node:fs/promises";
import { createLibrary, expect, imageFixture, shot, test } from "./fixtures.js";

test("filenames edit inline, save on Enter, retain failed drafts, and do not save on blur", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const originalName = `${"A landscape with a long filename ".repeat(4)}.png`;
	const image = await imageFixture(page, originalName, 960, 540);
	await page.getByLabel("Upload", { exact: true }).setInputFiles(image);
	const card = page.getByRole("article");
	await expect(card).toHaveCount(1);
	const label = () =>
		card.getByRole("button", { name: `Edit filename ${originalName}` });
	await label().hover();
	expect(
		await label().evaluate(
			(element) => getComputedStyle(element).borderTopColor,
		),
	).not.toBe("rgba(0, 0, 0, 0)");
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 780 });
		await label().hover();
		await shot(page, `filename-hover-${width}`);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	}
	let updates = 0;
	page.on("request", (request) => {
		if (request.method() === "PUT" && request.url().endsWith("/meta")) {
			updates++;
		}
	});
	await label().click();
	const input = () =>
		card.getByRole("textbox", { name: `Filename for ${originalName}` });
	await expect(input()).toBeFocused();
	await input().fill("Unsaved.png");
	await page.getByRole("searchbox").click();
	await expect(input()).toHaveCount(0);
	await expect(label()).toBeVisible();
	expect(updates).toBe(0);
	await label().click();
	await expect(input()).toHaveValue(originalName);
	await input().press("Escape");
	await expect(label()).toBeFocused();
	await label().click();
	await expect(input()).toHaveValue(originalName);
	await input().press("Enter");
	await expect(label()).toBeFocused();
	expect(updates).toBe(0);

	const pattern = "**/api/media/*/meta";
	await page.route(pattern, (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/json",
			body: '{"error":"Filename update unavailable"}',
		}),
	);
	await label().click();
	await input().fill("Renamed landscape.png");
	await input().press("Enter");
	await expect(
		card.getByText("Filename update unavailable", { exact: true }),
	).toBeVisible();
	await expect(input()).toHaveValue("Renamed landscape.png");
	await expect(input()).toBeFocused();
	await card.getByText("File details", { exact: true }).click();
	await expect(input()).toHaveCount(0);
	await label().click();
	await expect(input()).toHaveValue(originalName);
	await input().fill("Renamed landscape.png");
	await page.unroute(pattern);
	await shot(page, "filename-failed-draft");
	await input().press("Enter");
	const renamed = card.getByRole("button", {
		name: "Edit filename Renamed landscape.png",
	});
	await expect(renamed).toBeFocused();
	await expect(
		card.getByRole("button", { name: "Add tag to Renamed landscape.png" }),
	).toBeVisible();
	await expect(
		card.getByRole("button", { name: "Open Renamed landscape.png" }),
	).toBeVisible();
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("Renamed landscape.png");
	expect(await readFile(await download.path())).toEqual(image.buffer);

	let release;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	await page.route(pattern, async (route) => {
		await held;
		await route.continue();
	});
	const preview = card.locator("img");
	const imageNode = await preview.elementHandle();
	const source = await preview.getAttribute("src");
	try {
		await renamed.click();
		const pending = card.getByRole("textbox", {
			name: "Filename for Renamed landscape.png",
		});
		await pending.fill("Final landscape.png");
		await pending.press("Enter");
		await expect(pending).toHaveAttribute("readonly", "");
		await expect(
			card.getByRole("button", { name: "Open Renamed landscape.png" }),
		).toBeDisabled();
		await expect(preview.locator("..")).toHaveCSS("opacity", "1");
		expect(await imageNode.evaluate((element) => element.isConnected)).toBe(
			true,
		);
		await expect(preview).toHaveAttribute("src", source);
		await shot(page, "filename-saving-preview");
		await page.getByRole("searchbox").click();
		await expect(pending).toHaveCount(0);
		release();
		await expect(
			card.getByRole("button", { name: "Edit filename Final landscape.png" }),
		).toBeVisible();
		await expect(page.getByRole("searchbox")).toBeFocused();
		expect(await imageNode.evaluate((element) => element.isConnected)).toBe(
			true,
		);
		await expect(preview).toHaveAttribute("src", source);
	} finally {
		release();
		await page.unroute(pattern);
	}
});
