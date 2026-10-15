import { createLibrary, expect, shot, test } from "./fixtures.js";

test("mobile tags wrap with usable touch controls and retain failed drafts", async ({
	page,
	app,
}) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "Notes with a long descriptive filename.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("A readable note on a narrow screen."),
	});
	const card = page.getByRole("article");
	await expect(card).toBeVisible();
	await page.getByRole("button", { name: "Dismiss completed uploads" }).click();
	const add = card.getByRole("button", { name: /^Add tag to / });
	const touch = async (locator) => {
		const box = await locator.boundingBox();
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
	};
	const tagTouch = async (locator) => {
		await touch(locator);
		const box = await locator.boundingBox();
		const icon = await locator.locator("svg").boundingBox();
		expect(
			Math.abs(icon.x + icon.width / 2 - (box.x + box.width / 2)),
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(icon.y + icon.height / 2 - (box.y + box.height / 2)),
		).toBeLessThanOrEqual(1);
	};
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await tagTouch(add);
		await shot(page, `tag-add-${width}`);
	}
	await add.click();
	const input = card.getByRole("textbox", { name: /^New tag for / });
	const tag = "AnUnbrokenTagThatNeedsToWrapAcrossNarrowCards";
	await input.fill(tag);
	await card.getByRole("button", { name: "Save tag", exact: true }).click();
	await expect(input).toBeFocused();
	await expect(input).toHaveValue("");
	await tagTouch(
		card.getByRole("button", { name: `Remove tag ${tag}`, exact: true }),
	);
	await input.fill("Remember");
	await input.press("Enter");
	await input.fill("remember");
	await input.press("Enter");
	await expect(card.locator(".tag-text")).toHaveText([tag, "Remember"]);
	await page.route("**/api/media/*/meta", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/json",
			body: '{"error":"Tag update unavailable"}',
		}),
	);
	await input.fill("Keep my draft");
	await input.press("Enter");
	await expect(
		card.getByText("Tag update unavailable", { exact: true }),
	).toBeVisible();
	await expect(input).toHaveValue("Keep my draft");
	await expect(input).toBeFocused();
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await tagTouch(card.getByRole("button", { name: "Save tag", exact: true }));
		await tagTouch(
			card.getByRole("button", { name: "Cancel adding tag", exact: true }),
		);
		await tagTouch(
			card.getByRole("button", { name: `Remove tag ${tag}`, exact: true }),
		);
		expect((await input.boundingBox()).width).toBeGreaterThan(100);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await shot(page, `tag-editor-${width}`);
	}
	await page.unroute("**/api/media/*/meta");
	await input.press("Escape");
	await expect(add).toBeFocused();
	await card
		.getByRole("button", { name: `Remove tag ${tag}`, exact: true })
		.click();
	await expect(card.locator(".tag-text")).toHaveText(["Remember"]);
	await card.getByRole("button", { name: /^Open Notes/ }).click();
	await expect(page.locator("dialog pre")).toHaveText(
		"A readable note on a narrow screen.",
	);
	const panel = await page.locator(".text-preview").boundingBox();
	for (const label of ["Previous media", "Next media"]) {
		const button = page.getByRole("button", { name: label, exact: true });
		await touch(button);
		expect((await button.boundingBox()).y).toBeGreaterThanOrEqual(
			panel.y + panel.height,
		);
	}
	await shot(page, "mobile-text-controls");
});
