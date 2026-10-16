import { createLibrary, expect, shot, test } from "./fixtures.js";

test("upload generates searchable ordinary tags with a compact disclosure", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const name = `${Array.from({ length: 45 }, (_, i) => `a${i}`).join(" ")}.txt`;
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles({
			name,
			mimeType: "text/plain",
			buffer: Buffer.from("Useful text"),
		});
	const card = page.getByRole("article");
	await expect(card.locator(".tag-text")).toHaveCount(6);
	await card
		.getByRole("button", { name: "Show all tags", exact: true })
		.click();
	await expect(card.locator(".tag-text")).toHaveCount(40);
	await card
		.getByRole("button", { name: "Remove tag a37", exact: true })
		.click();
	await expect(card.locator(".tag-text")).toHaveCount(39);
	await page.reload();
	await page.getByLabel("Master password", { exact: true }).fill("test-pass-1");
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
	await card
		.getByRole("button", { name: "Show all tags", exact: true })
		.click();
	await expect(card.locator(".tag-text")).toHaveCount(39);
	await expect(
		card.getByRole("button", { name: "Remove tag a37", exact: true }),
	).toHaveCount(0);
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		for (const theme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme: theme });
			await shot(page, `auto-tags-${width}-${theme}`);
		}
	}
});
