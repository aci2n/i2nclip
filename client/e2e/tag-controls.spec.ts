import type { Locator } from "@playwright/test";
import { assertPresent } from "../tests/assert.ts";
import { createLibrary, expect, imageFixture, shot, test } from "./fixtures.ts";

async function alignedClear(form: Locator) {
	const field = await form.boundingBox();
	const clear = await form
		.getByRole("button", { name: "Clear search", exact: true })
		.boundingBox();
	expect(
		Math.abs(
			assertPresent(clear).y +
				assertPresent(clear).height / 2 -
				(assertPresent(field).y + assertPresent(field).height / 2),
		),
	).toBeLessThanOrEqual(1);
	expect(
		assertPresent(clear).x + assertPresent(clear).width,
	).toBeLessThanOrEqual(assertPresent(field).x + assertPresent(field).width);
	const icon = await form
		.getByRole("button", { name: "Clear search", exact: true })
		.locator("svg")
		.boundingBox();
	expect(
		Math.abs(
			assertPresent(icon).x +
				assertPresent(icon).width / 2 -
				(assertPresent(clear).x + assertPresent(clear).width / 2),
		),
	).toBeLessThanOrEqual(1);
	expect(
		Math.abs(
			assertPresent(icon).y +
				assertPresent(icon).height / 2 -
				(assertPresent(clear).y + assertPresent(clear).height / 2),
		),
	).toBeLessThanOrEqual(1);
}
async function matchingCardControls(card: Locator, touch: boolean) {
	const chip = await card
		.getByRole("button", { name: /^Remove tag / })
		.first()
		.locator("..")
		.boundingBox();
	const disclosure = await card
		.getByRole("button", { name: "Show all tags", exact: true })
		.boundingBox();
	expect(
		Math.abs(assertPresent(chip).height - assertPresent(disclosure).height),
	).toBeLessThanOrEqual(1);
	if (touch) {
		expect(assertPresent(disclosure).height).toBeGreaterThanOrEqual(44);
		const remove = await card
			.getByRole("button", { name: /^Remove tag / })
			.first()
			.boundingBox();
		expect(assertPresent(remove).width).toBeGreaterThanOrEqual(44);
		expect(assertPresent(remove).height).toBeGreaterThanOrEqual(44);
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
	await expect(
		card.getByRole("button", { name: "Show all tags", exact: true }),
	).toHaveText(/^\+\d+ more$/);
	const visibleTags = await card
		.getByRole("button", { name: /^Search for tag / })
		.count();
	await card
		.getByRole("button", { name: "Show all tags", exact: true })
		.click();
	await expect(
		card.getByRole("button", { name: /^Search for tag / }),
	).not.toHaveCount(visibleTags);
	await card
		.getByRole("button", { name: "Show fewer tags", exact: true })
		.click();
	await expect(
		card.getByRole("button", { name: /^Search for tag / }),
	).toHaveCount(visibleTags);
	await expect(
		page.getByRole("button", { name: /^Remove search tag / }),
	).toHaveCount(0);
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
	expect(assertPresent(field).height).toBeLessThanOrEqual(
		assertPresent(empty).height + 1,
	);
	expect(assertPresent(chip).height).toBeLessThan(assertPresent(field).height);
	expect(assertPresent(chip).y).toBeGreaterThanOrEqual(assertPresent(field).y);
	expect(
		assertPresent(chip).y + assertPresent(chip).height,
	).toBeLessThanOrEqual(assertPresent(field).y + assertPresent(field).height);
	await alignedClear(form);
	await shot(page, "compact-tags-desktop");
	for (let index = 0; index < 4; index++) {
		await search.fill(
			`A long search label with several words to check wrapping ${index}`,
		);
		await search.press("Enter");
	}
	expect(assertPresent(await form.boundingBox()).height).toBeGreaterThan(
		assertPresent(field).height,
	);
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await alignedClear(form);
		if (width < 500) {
			for (const button of await form.getByRole("button").all()) {
				const box = await button.boundingBox();
				expect(assertPresent(box).width).toBeGreaterThanOrEqual(44);
				expect(assertPresent(box).height).toBeGreaterThanOrEqual(44);
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
