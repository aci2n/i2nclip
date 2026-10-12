import { readFile } from "node:fs/promises";
import {
	chooseRestore,
	expect,
	fillCreation,
	issueOtc,
	openServer,
	PASSWORD,
	png,
	resetLibrary,
	test,
} from "./fixtures.js";
async function setup(page, app) {
	await page.goto(`${app.origin}/?page=options`);
	await openServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, await issueOtc(app.data));
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#status")).toContainText("Library created.");
}

test("web SharedWorker shares unlock and media changes while tabs keep independent searches", async ({
	page,
	app,
}) => {
	await setup(page, app);
	const second = await page.context().newPage();
	await second.goto(app.origin);
	await expect(second.locator("#files")).toBeAttached();
	await expect(second.locator("#unlock")).toBeHidden();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.locator("#files")
		.setInputFiles({ name: "web.png", mimeType: "image/png", buffer: png });
	await expect(page.locator(".card-title")).toHaveText("web.png");
	await expect(second.locator(".card-title")).toHaveText("web.png");
	await page
		.locator(".card")
		.getByRole("button", { name: "Add tag to web.png" })
		.click();
	await page.locator(".tags input").fill("Web");
	await page.locator(".tags input").press("Enter");
	await expect(second.locator(".tag-text")).toHaveText(["Web"]);
	await second.locator("#tags").fill("absent");
	await second.locator("#tags").press("Enter");
	await expect(second.locator("#empty-library")).toContainText(
		"No files match",
	);
	await expect(page.locator(".card-title")).toHaveText("web.png");
	await page.bringToFront();
	const download = page.waitForEvent("download");
	await page.locator('[data-act="download"]').click();
	expect(await readFile(await (await download).path())).toEqual(png);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await resetLibrary(page);
	await expect(second.locator("#files")).not.toBeAttached();
	await second.close();
});

test("web and extension owners have independent configuration and unlocked scopes", async ({
	page,
	app,
}) => {
	await setup(page, app);
	const extension = await page.context().newPage();
	await extension.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await expect(extension.locator("#setup")).toBeVisible();
	await expect(page.locator("#configured")).toBeVisible();
	await extension.close();
});

test("web recovery can restore another browser context and survives page navigation", async ({
	page,
	app,
	browser,
}) => {
	await setup(page, app);
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download recovery file" }).click();
	const recovery = await readFile(await (await download).path());
	const context = await browser.newContext();
	try {
		const other = await context.newPage();
		await other.goto(`${app.origin}/?page=options`);
		await chooseRestore(other);
		await other.locator("#file").setInputFiles({
			name: "recovery.json",
			mimeType: "application/json",
			buffer: recovery,
		});
		await other.locator("#restore-pass").fill(PASSWORD);
		await other.locator("#restore-pass").press("Enter");
		await expect(other.locator("#status")).toHaveText(
			"Library restored and unlocked.",
		);
		await other.getByRole("link", { name: "Library", exact: true }).click();
		await expect(other.locator("#files")).toBeAttached();
	} finally {
		await context.close();
	}
});
