import { readFile } from "node:fs/promises";
import {
	chooseRestore,
	expect,
	fillCreation,
	issueOtc,
	openServer,
	PASSWORD,
	png,
	test,
} from "./fixtures.js";

test("web client uses the Rust origin for setup, media, and restored identities", async ({
	page,
	app,
}) => {
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${app.origin}/?page=options`);
	await openServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, await issueOtc(app.data));
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#status")).toContainText("Library created.");

	const recoveryDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download recovery file" }).click();
	const recovery = await readFile(await (await recoveryDownload).path());
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.locator("#files")
		.setInputFiles({ name: "web.png", mimeType: "image/png", buffer: png });
	const card = page.locator(".card");
	await expect(card.locator(".card-title")).toHaveText("web.png");
	await card.getByRole("button", { name: "Add tag to web.png" }).click();
	await card.locator(".tags input").fill("Web");
	await card.locator(".tags input").press("Enter");
	await expect(card.locator(".tag-text")).toHaveText(["Web"]);
	await page.locator("#tags").fill("web");
	await page.locator("#tags").press("Enter");
	await expect(card).toHaveCount(1);

	const mediaDownload = page.waitForEvent("download");
	await card.locator('[data-act="download"]').click();
	expect(await readFile(await (await mediaDownload).path())).toEqual(png);
	await page.reload();
	await expect(card.locator(".card-title")).toHaveText("web.png");
	expect(new URL(page.url()).origin).toBe(app.origin);

	// A second browser context has no stored identity and restores the same library.
	const context = await page.context().browser().newContext();
	try {
		const restored = await context.newPage();
		await restored.goto(`${app.origin}/?page=options`);
		await chooseRestore(restored);
		await restored.locator("#file").setInputFiles({
			name: "recovery.json",
			mimeType: "application/json",
			buffer: recovery,
		});
		await restored.locator("#restore-pass").fill(PASSWORD);
		await restored.locator("#restore-pass").press("Enter");
		await expect(restored.locator("#status")).toHaveText(
			"Library restored and unlocked.",
		);
		await restored.getByRole("link", { name: "Library", exact: true }).click();
		await expect(restored.locator(".card-title")).toHaveText("web.png");
	} finally {
		await context.close();
	}
	expect(errors).toEqual([]);
});
