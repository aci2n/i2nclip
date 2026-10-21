import { readFile } from "node:fs/promises";
import { createLibrary, expect, test } from "./fixtures.ts";

test("Unicode metadata remains searchable locally and renamed downloads preserve content", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const bytes = Buffer.from("Unicode tag regression");
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "Unicode.txt",
		mimeType: "text/plain",
		buffer: bytes,
	});
	const card = page.getByRole("article");
	await expect(card).toHaveCount(1);
	const tag = "가".normalize("NFD").repeat(64);
	await card
		.getByRole("button", { name: "Add tag to Unicode.txt", exact: true })
		.click();
	const draft = card.getByRole("textbox", {
		name: "New tag for Unicode.txt",
		exact: true,
	});
	await draft.fill(tag);
	await draft.press("Enter");
	await expect(
		card.getByRole("button", { name: `Remove tag ${tag}`, exact: true }),
	).toBeVisible();
	let searchRequests = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/blocks") {
			searchRequests++;
		}
	});
	await page
		.getByRole("searchbox", { name: "Search files", exact: true })
		.fill(tag.normalize("NFC"));
	await page
		.getByRole("searchbox", { name: "Search files", exact: true })
		.press("Enter");
	await expect(card).toHaveCount(1);
	expect(searchRequests).toBe(0);
	await card
		.getByRole("button", { name: "Edit filename Unicode.txt", exact: true })
		.click();
	const name = card.getByRole("textbox", {
		name: "Filename for Unicode.txt",
		exact: true,
	});
	await name.fill("Renamed.txt");
	await name.press("Enter");
	await expect(
		card.getByRole("button", { name: "Open Renamed.txt", exact: true }),
	).toBeVisible();
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("Renamed.txt");
	expect(await readFile(await download.path())).toEqual(bytes);
	await page.reload();
	await page.getByLabel("Master password", { exact: true }).fill("test-pass-1");
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
	await expect(
		card.getByRole("button", { name: "Open Renamed.txt", exact: true }),
	).toBeVisible();
});
