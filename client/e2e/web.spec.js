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

for (const missedEvents of [false, true]) {
	test(`web reset invalidates other tabs after restoring the same library: ${missedEvents ? "missed events" : "live events"}`, async ({
		page,
		app,
	}) => {
		await page.goto(`${app.origin}/?page=options`);
		await openServer(page);
		await page.locator("#server").fill(app.origin);
		await fillCreation(page, await issueOtc(app.data));
		await page.locator("#pass").press("Enter");
		await expect(page.locator("#status")).toContainText("Library created.");
		const download = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download recovery file" }).click();
		const recovery = await readFile(await (await download).path());
		const generation = await page.evaluate(
			() => JSON.parse(localStorage.getItem("i2nclip")).identityGeneration,
		);
		const second = await page.context().newPage();
		await second.goto(app.origin);
		await expect(second.locator("#unlock")).toBeVisible();
		await second.locator("#pass").fill(PASSWORD);
		await second.locator("#pass").press("Enter");
		await expect(second.locator("#files")).toBeAttached();
		if (missedEvents) {
			// Model a suspended page missing every storage/resume notification.
			await second.evaluate(() => {
				window.suppressSessionEvents = true;
				const suppress = (event) => {
					if (window.suppressSessionEvents) event.stopImmediatePropagation();
				};
				for (const type of ["storage", "pageshow", "focus"])
					window.addEventListener(type, suppress, { capture: true });
				document.addEventListener("visibilitychange", suppress, {
					capture: true,
				});
			});
		}
		await resetLibrary(page);
		if (!missedEvents) {
			await expect
				.poll(() =>
					second.evaluate(
						() =>
							JSON.parse(sessionStorage.getItem("i2nclip") || "{}").privateKey,
					),
				)
				.toBeUndefined();
			await expect(second.locator("#files")).not.toBeAttached();
		}
		await chooseRestore(page);
		await page.locator("#file").setInputFiles({
			name: "recovery.json",
			mimeType: "application/json",
			buffer: recovery,
		});
		await page.locator("#restore-pass").fill(PASSWORD);
		await page.locator("#restore-pass").press("Enter");
		await expect(page.locator("#status")).toHaveText(
			"Library restored and unlocked.",
		);
		expect(
			await page.evaluate(
				() => JSON.parse(localStorage.getItem("i2nclip")).identityGeneration,
			),
		).not.toBe(generation);
		if (missedEvents) {
			expect(
				await second.evaluate(
					() => JSON.parse(sessionStorage.getItem("i2nclip")).privateKey,
				),
			).toBeTruthy();
			await second.evaluate(() => {
				window.suppressSessionEvents = false;
				window.dispatchEvent(new Event("pageshow"));
			});
		}
		await expect(second.locator("#unlock")).toBeVisible();
		expect(
			await second.evaluate(
				() => JSON.parse(sessionStorage.getItem("i2nclip") || "{}").privateKey,
			),
		).toBeUndefined();
		await second.reload();
		await expect(second.locator("#unlock")).toBeVisible();
		await second.locator("#pass").fill(PASSWORD);
		await second.locator("#pass").press("Enter");
		await expect(second.locator("#files")).toBeAttached();
		await second.close();
	});
}
