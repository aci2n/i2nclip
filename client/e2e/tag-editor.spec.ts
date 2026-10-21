import { encode } from "../src/lib/protocol/msgpack.ts";
import { createLibrary, expect, shot, test } from "./fixtures.ts";

test("tag suggestions save immediately, retain failed drafts and disappear after their last use", async ({
	page,
	app,
}) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(
		["Alpha.txt", "Beta.txt"].map((name) => ({
			name,
			mimeType: "text/plain",
			buffer: Buffer.from(name),
		})),
	);
	await expect(page.getByRole("article")).toHaveCount(2);
	const alpha = page.getByRole("article").filter({ hasText: "Alpha.txt" });
	const beta = page.getByRole("article").filter({ hasText: "Beta.txt" });
	await alpha
		.getByRole("button", { name: "Add tag to Alpha.txt", exact: true })
		.click();
	const input = alpha.getByRole("textbox", {
		name: "New tag for Alpha.txt",
		exact: true,
	});
	await input.fill("be");
	await expect(
		alpha.getByRole("button", { name: "beta", exact: true }),
	).toBeVisible();
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await shot(page, `tag-editor-suggestions-${width}`);
	}
	await page.route("**/api/blocks", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/msgpack",
			body: Buffer.from(encode({ error: "Tag update unavailable" })),
		}),
	);
	await alpha.getByRole("button", { name: "beta", exact: true }).click();
	await expect(
		alpha.getByText("Server request failed (HTTP 503).", { exact: true }),
	).toBeVisible();
	await expect(input).toHaveValue("beta");
	await expect(input).toBeFocused();
	await page.unroute("**/api/blocks");
	await input.press("Enter");
	await expect(
		alpha.getByRole("button", { name: "Remove tag beta", exact: true }),
	).toBeVisible();
	await expect(input).toHaveValue("");
	await expect(input).toBeFocused();
	await input.fill("beta");
	await expect(
		alpha.getByRole("button", { name: "beta", exact: true }),
	).toHaveCount(0);
	await input.press("Escape");
	await alpha
		.getByRole("button", { name: "Remove tag beta", exact: true })
		.click();
	await beta
		.getByRole("button", { name: "Remove tag beta", exact: true })
		.click();
	await alpha
		.getByRole("button", { name: "Add tag to Alpha.txt", exact: true })
		.click();
	await input.fill("beta");
	await expect(
		alpha.getByRole("button", { name: "beta", exact: true }),
	).toHaveCount(0);
	await input.press("Enter");
	await expect(
		alpha.getByRole("button", { name: "Remove tag beta", exact: true }),
	).toBeVisible();
});
