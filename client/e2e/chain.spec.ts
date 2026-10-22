import { readFile } from "node:fs/promises";
import {
	createLibrary,
	expect,
	restore,
	savedBackup,
	test,
} from "./fixtures.ts";

test("verified history projects edits, deletion, restoration and permanent purge", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "original.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("private content"),
	});
	const card = page.getByRole("article");
	await expect(card).toHaveCount(1);
	await expect(page.getByLabel("Block", { exact: true })).toHaveValue("1");
	await card
		.getByRole("button", { name: "Edit filename original.txt", exact: true })
		.click();
	await card
		.getByRole("textbox", { name: "Filename for original.txt", exact: true })
		.fill("renamed.txt");
	await card
		.getByRole("textbox", { name: "Filename for original.txt", exact: true })
		.press("Enter");
	await expect(page.getByLabel("Block", { exact: true })).toHaveValue("2");
	await page.getByLabel("Block", { exact: true }).fill("1");
	await page.getByRole("button", { name: "Browse block", exact: true }).click();
	await expect(
		page.getByText("Read-only history at block 1.", { exact: true }),
	).toBeVisible();
	await expect(
		card.getByRole("button", { name: "Open original.txt", exact: true }),
	).toBeVisible();
	await expect(
		card.getByRole("button", { name: "Delete", exact: true }),
	).toBeDisabled();
	await expect(page.getByLabel("Upload", { exact: true })).toBeDisabled();
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("original.txt");
	expect((await readFile(await download.path())).toString()).toBe(
		"private content",
	);
	await page.getByRole("button", { name: "Live view", exact: true }).click();
	await expect(
		card.getByRole("button", { name: "Open renamed.txt", exact: true }),
	).toBeVisible();
	await card.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(card).toHaveCount(0);
	await page
		.getByRole("button", { name: "Deleted files", exact: true })
		.click();
	await expect(card).toHaveCount(1);
	await card
		.getByRole("button", { name: "Restore backup", exact: true })
		.click();
	await expect(card).toHaveCount(0);
	await page.getByRole("button", { name: "Files", exact: true }).click();
	await expect(card).toHaveCount(1);
	await card.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("button", { name: "Deleted files", exact: true })
		.click();
	page.once("dialog", (dialog) => dialog.accept());
	await card
		.getByRole("button", { name: "Permanently delete", exact: true })
		.click();
	await expect(card).toHaveCount(0);
	await page.getByLabel("Block", { exact: true }).fill("1");
	await page.getByRole("button", { name: "Browse block", exact: true }).click();
	await page.getByRole("button", { name: "Files", exact: true }).click();
	await expect(
		card.getByText("Permanently purged", { exact: true }),
	).toBeVisible();
	await expect(
		card.getByRole("button", { name: "Download", exact: true }),
	).toBeDisabled();
});

test("offline savedBackup restores control without a device and preserves encrypted history", async ({
	page,
	app,
	browser,
}) => {
	await createLibrary(page, app);
	const bytes = await savedBackup(page);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "retained.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("retained across savedBackup"),
	});
	await expect(page.getByRole("article")).toHaveCount(1);
	const restoredContext = await browser.newContext();
	try {
		const restored = await restoredContext.newPage();
		await restore(restored, app, bytes);
		await restored.getByRole("link", { name: "Library", exact: true }).click();
		const card = restored.getByRole("article");
		await expect(
			card.getByRole("button", { name: "Open retained.txt", exact: true }),
		).toBeVisible();
		const downloading = restored.waitForEvent("download");
		await card.getByRole("button", { name: "Download", exact: true }).click();
		expect((await readFile(await (await downloading).path())).toString()).toBe(
			"retained across savedBackup",
		);
	} finally {
		await restoredContext.close();
	}
});
