import { createLibrary, expect, test } from "./fixtures.ts";

test("local name and tag search commits on Enter and refresh preserves the submitted query", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(
		["Alpha.txt", "Beta.txt"].map((name) => ({
			name,
			mimeType: "text/plain",
			buffer: Buffer.from(name),
		})),
	);
	const cards = page.getByRole("article");
	await expect(cards).toHaveCount(2);
	const search = page.getByRole("searchbox", {
		name: "Search files",
		exact: true,
	});
	await search.fill("Alpha");
	await expect(cards).toHaveCount(2);
	await search.press("Enter");
	await expect(cards).toHaveCount(1);
	await expect(
		cards.getByRole("button", { name: "Open Alpha.txt", exact: true }),
	).toBeVisible();
	await search.fill("unsubmitted");
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(cards).toHaveCount(1);
	await page.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(cards).toHaveCount(2);
	await expect(search).toHaveValue("");
	await search.fill("missing");
	await search.press("Enter");
	await expect(cards).toHaveCount(0);
	await expect(
		page.getByRole("heading", {
			name: "No files match your search",
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Clear search", exact: true })
		.first()
		.click();
	const alpha = cards.filter({ hasText: "Alpha.txt" });
	await alpha
		.getByRole("button", { name: "Search for tag alpha", exact: true })
		.click();
	await expect(cards).toHaveCount(1);
});
