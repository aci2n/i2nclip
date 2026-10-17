import { assertPresent } from "../tests/assert.ts";
import { createLibrary, expect, master, shot, test } from "./fixtures.ts";

test("navigation contains views, with Lock in the header and About in Settings", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const nav = page.getByRole("navigation", { name: "Main navigation" });
	await expect(nav.getByRole("link")).toHaveText(["Library", "Settings"]);
	await expect(nav.getByRole("button")).toHaveCount(0);
	const lock = page
		.locator("header")
		.getByRole("button", { name: "Lock", exact: true });
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
		await lock.scrollIntoViewIfNeeded();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		if (width < 400) {
			const lockBox = await lock.boundingBox();
			const navBox = await nav.boundingBox();
			expect(assertPresent(navBox).y).toBeGreaterThanOrEqual(
				assertPresent(lockBox).y + assertPresent(lockBox).height,
			);
		}
		await shot(page, `settings-navigation-${width}`);
	}
	await lock.click();
	await master(page);
	await expect(dialog).not.toBeVisible();
	await nav.getByRole("link", { name: "Library", exact: true }).click();
	await expect(about).toHaveCount(0);
	await expect(lock).toBeVisible();
});
