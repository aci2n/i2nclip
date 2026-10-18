import { deferred } from "../tests/helpers.ts";
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

test("an upload survives navigation through Settings", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const pending = deferred();
	const started = deferred();
	await page.route(/\/api\/media\/[0-9a-f]{64}$/, async (route) => {
		if (route.request().method() === "PUT") {
			started.resolve();
			await pending.promise;
		}
		await route.continue().catch(() => {});
	});
	try {
		await page.getByLabel("Upload", { exact: true }).setInputFiles({
			name: "survives-navigation.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("upload remains owned by the application"),
		});
		await started.promise;
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await page.getByRole("link", { name: "Library", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeDisabled();
		pending.resolve();
		await expect(
			page
				.getByRole("article")
				.getByText("survives-navigation.txt", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeEnabled();
	} finally {
		pending.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});
