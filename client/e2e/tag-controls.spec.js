import { createLibrary, expect, imageFixture, shot, test } from "./fixtures.js";

async function alignedClear(form) {
	const field = await form.boundingBox();
	const clear = await form
		.getByRole("button", { name: "Clear search", exact: true })
		.boundingBox();
	expect(
		Math.abs(clear.y + clear.height / 2 - (field.y + field.height / 2)),
	).toBeLessThanOrEqual(1);
	expect(clear.x + clear.width).toBeLessThanOrEqual(field.x + field.width);
	const icon = await form
		.getByRole("button", { name: "Clear search", exact: true })
		.locator("svg")
		.boundingBox();
	expect(
		Math.abs(icon.x + icon.width / 2 - (clear.x + clear.width / 2)),
	).toBeLessThanOrEqual(1);
	expect(
		Math.abs(icon.y + icon.height / 2 - (clear.y + clear.height / 2)),
	).toBeLessThanOrEqual(1);
}

async function matchingCardControls(card, touch) {
	const chip = await card
		.getByRole("button", { name: /^Remove tag / })
		.first()
		.locator("..")
		.boundingBox();
	const disclosure = await card
		.getByRole("button", { name: "Show all tags", exact: true })
		.boundingBox();
	expect(Math.abs(chip.height - disclosure.height)).toBeLessThanOrEqual(1);
	if (touch) {
		expect(disclosure.height).toBeGreaterThanOrEqual(44);
		const remove = await card
			.getByRole("button", { name: /^Remove tag / })
			.first()
			.boundingBox();
		expect(remove.width).toBeGreaterThanOrEqual(44);
		expect(remove.height).toBeGreaterThanOrEqual(44);
	}
}

test("tag controls fit desktop search and keep consistent alignment when wrapped or narrow", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles(
			await imageFixture(
				page,
				"Summer holiday family trip to the coast.png",
				960,
				540,
			),
		);
	const card = page.getByRole("article");
	await expect(card).toHaveCount(1);
	await matchingCardControls(card, false);
	const form = page.getByRole("form", { name: "Search library" });
	const search = page.getByRole("searchbox", { name: "Search tags" });
	const empty = await form.boundingBox();
	await search.fill("image");
	await search.press("Enter");
	await expect(
		form.getByRole("button", { name: "Remove search tag image", exact: true }),
	).toBeVisible();
	const field = await form.boundingBox();
	const chip = await form
		.getByRole("button", { name: "Remove search tag image", exact: true })
		.locator("..")
		.boundingBox();
	expect(field.height).toBeLessThanOrEqual(empty.height + 1);
	expect(chip.height).toBeLessThan(field.height);
	expect(chip.y).toBeGreaterThanOrEqual(field.y);
	expect(chip.y + chip.height).toBeLessThanOrEqual(field.y + field.height);
	await alignedClear(form);
	await shot(page, "compact-tags-desktop");
	for (let index = 0; index < 4; index++) {
		await search.fill(
			`A long search label with several words to check wrapping ${index}`,
		);
		await search.press("Enter");
	}
	expect((await form.boundingBox()).height).toBeGreaterThan(field.height);
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await alignedClear(form);
		if (width < 500) {
			for (const button of await form.getByRole("button").all()) {
				const box = await button.boundingBox();
				expect(box.width).toBeGreaterThanOrEqual(44);
				expect(box.height).toBeGreaterThanOrEqual(44);
			}
		}
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await shot(page, `wrapped-search-${width}`);
	}
	await form.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(card).toHaveCount(1);
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await matchingCardControls(card, true);
		await shot(page, `card-tag-controls-${width}`);
	}
});
