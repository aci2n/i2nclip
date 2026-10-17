import { createLibrary, expect, shot, test } from "./fixtures.ts";

test("navigation contains views and About remains in Settings", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const nav = page.getByRole("navigation", { name: "Main navigation" });
	await expect(nav.getByRole("link")).toHaveText(["Library", "Settings"]);
	await expect(nav.getByRole("button")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Lock", exact: true }),
	).toHaveCount(0);
	const about = page.getByRole("button", { name: "About", exact: true });
	await expect(about).toBeVisible();
	await about.click();
	const dialog = page.getByRole("dialog", { name: "About i2nclip" });
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(about).toBeFocused();
	for (const width of [1100, 360, 320]) {
		await page.setViewportSize({ width, height: 800 });
		await nav.scrollIntoViewIfNeeded();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await shot(page, `settings-navigation-${width}`);
	}

	await expect(dialog).not.toBeVisible();
	await nav.getByRole("link", { name: "Library", exact: true }).click();
	await expect(about).toHaveCount(0);
});
