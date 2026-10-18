import {
	createLibrary,
	expect,
	openUploadPreferences,
	shot,
	test,
} from "./fixtures.ts";

test("Settings opens only the library section and disclosures reset after navigation", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await expect(page.locator(".settings > details[open]")).toHaveCount(1);
	await expect(page.locator(".settings > details[open] > summary")).toHaveText(
		"Your library",
	);
	await expect(
		page.getByRole("checkbox", {
			name: "Compress images to WebP",
			exact: true,
		}),
	).not.toBeVisible();
	await openUploadPreferences(page);
	await expect(
		page.getByRole("checkbox", {
			name: "Compress images to WebP",
			exact: true,
		}),
	).toBeVisible();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(page.locator(".settings > details[open]")).toHaveCount(1);
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await shot(page, `settings-collapsed-${width}`);
	}
	await openUploadPreferences(page);
	await expect(page.locator(".settings select")).toHaveCount(0);
	await expect(page.getByRole("checkbox")).toHaveCount(1);
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await shot(page, `settings-image-compression-${width}`);
	}
});

test("canceling pairing deletes its room once without a duplicate 404", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByText("Connect another device", { exact: true }).click();
	await page
		.getByRole("button", { name: "Create pairing code", exact: true })
		.click();
	await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
	const deletions: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "DELETE" &&
			/\/api\/pairings\//.test(request.url())
		) {
			deletions.push(request.url());
		}
	});
	const deleted = page.waitForResponse(
		(response) =>
			response.request().method() === "DELETE" &&
			/\/api\/pairings\//.test(response.url()),
	);
	await page
		.getByRole("button", { name: "Cancel pairing", exact: true })
		.click();
	expect((await deleted).status()).toBe(204);
	await expect(
		page.getByRole("button", { name: "Create pairing code", exact: true }),
	).toBeVisible();
	expect(deletions).toHaveLength(1);
});
