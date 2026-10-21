import type { Locator } from "@playwright/test";
import { assertPresent } from "../tests/assert.ts";
import { createLibrary, expect, imageFixture, shot, test } from "./fixtures.ts";

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
	await expect(card).toHaveCount(1);
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await matchingCardControls(card, true);
		await shot(page, `card-tag-controls-${width}`);
	}
});
