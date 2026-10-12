import { createLibrary, expect, test } from "./fixtures.js";

test("fresh uploads have distinct content hashes and immutable verified downloads", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	for (const name of ["first.txt", "second.txt"]) {
		await page.locator("#files").setInputFiles({
			name,
			mimeType: "text/plain",
			buffer: Buffer.from("same media, fresh encryption"),
		});
		await expect(
			page.locator(".card-title").filter({ hasText: name }),
		).toBeVisible();
	}
	const state = await page.evaluate(() => window.serviceTest("state"));
	const ids = Object.keys(state.media);
	expect(ids).toHaveLength(2);
	expect(ids[0]).not.toBe(ids[1]);
	for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
	const content = await page.evaluate(async (id) => {
		const result = await window.serviceTest("media.content", { id });
		return result.blob.text();
	}, ids[0]);
	expect(content).toBe("same media, fresh encryption");
	const card = page.locator(".card").filter({ hasText: "first.txt" });
	page.once("dialog", (dialog) => dialog.accept());
	await card.locator('[data-act="delete"]').click();
	await expect(page.locator(".card")).toHaveCount(1);
	expect(
		await page.evaluate(
			async (id) =>
				(await window.serviceTest("media.content", { id })).blob.text(),
			ids[1],
		),
	).toBe(content);
});
