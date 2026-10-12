import {
	expect,
	fillCreation,
	installBrowser,
	issueOtc,
	openServer,
	png,
	shot,
	test,
} from "./fixtures.js";
const url = (kind, app) =>
	kind === "web"
		? `${app.origin}/?page=options`
		: `${app.web.origin}/client/dist/extension/options.html`;
async function setup(page, kind, app) {
	await page.goto(url(kind, app));
	await openServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, await issueOtc(app.data));
	await page.locator("#create-library").click();
	await expect(page.locator("#status")).toContainText("Library created.");
}
async function receive(page, code, app) {
	await openServer(page);
	await page.locator("#server").fill(app.origin);
	await page.getByRole("tab", { name: "Pair", exact: true }).click();
	await page.locator("#pairing-input").fill(code);
	await page
		.getByRole("button", { name: "Connect library", exact: true })
		.click();
}
for (const [from, to] of [
	["web", "web"],
	["web", "extension"],
	["extension", "web"],
	["extension", "extension"],
]) {
	test(`pairing ${from} to ${to} uses the common interface and a new local password`, async ({
		page,
		app,
		browser,
	}) => {
		await setup(page, from, app);
		const original = await page.evaluate(() => window.serviceTest("config"));
		await page.getByRole("link", { name: "Library", exact: true }).click();
		await page.locator("#files").setInputFiles({
			name: "shared.png",
			mimeType: "image/png",
			buffer: png,
		});
		await expect(page.locator(".card-title")).toHaveText("shared.png");
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		const context = await browser.newContext();
		await context.addInitScript(installBrowser);
		try {
			const receiver = await context.newPage();
			await receiver.goto(url(to, app));
			await page.locator("#pairing-settings > summary").click();
			await page.locator("#pairing-start").click();
			await expect(page.locator("#pairing-code")).toBeVisible();
			const code = await page.locator("#pairing-code").textContent();
			await receive(receiver, code.toLowerCase(), app);
			await expect(page.locator("#pairing-approve")).toBeVisible();
			const verification = await page
				.locator("#pairing-verification-code")
				.textContent();
			await expect(receiver.locator("#pairing-verification-code")).toHaveText(
				verification,
			);
			expect(
				(await receiver.evaluate(() => window.serviceTest("state"))).session
					.unlocked,
			).toBe(false);
			if (from === "web" && to === "web") {
				await page.setViewportSize({ width: 320, height: 800 });
				await shot(page, "service-pairing-320");
			}
			await page.locator("#pairing-approve").click();
			await expect(page.locator("#pairing-status")).toContainText(
				"New device connected",
			);
			await expect(receiver.locator("#configured")).toBeVisible();
			const saved = await receiver.evaluate(() => window.serviceTest("config"));
			expect(saved.publicKey).toBe(original.publicKey);
			expect(saved.publicKey).toBe(original.publicKey);
			expect(
				(await receiver.evaluate(() => window.serviceTest("state"))).session,
			).not.toHaveProperty("privateKey");
			await receiver
				.getByRole("link", { name: "Library", exact: true })
				.click();
			await expect(receiver.locator(".card-title")).toHaveText("shared.png");
		} finally {
			await context.close();
		}
	});
}

for (const kind of ["web", "extension"]) {
	test(`${kind} pairing is shared and another tab can finish after both starting pages close`, async ({
		page,
		app,
		browser,
	}) => {
		await setup(page, kind, app);
		const follower = await page.context().newPage();
		await follower.goto(url(kind, app));
		await page.locator("#pairing-settings > summary").click();
		await follower.locator("#pairing-settings > summary").click();
		await page.locator("#pairing-start").click();
		await expect(page.locator("#pairing-code")).toBeVisible();
		const firstCode = await page.locator("#pairing-code").textContent();
		await expect(follower.locator("#pairing-code")).toHaveText(firstCode);
		await follower
			.getByRole("button", { name: "Cancel pairing", exact: true })
			.click();
		await expect(page.locator("#pairing-status")).toContainText("canceled");
		await expect(follower.locator("#pairing-status")).toContainText("canceled");
		await page.locator("#pairing-start").click();
		await expect(page.locator("#pairing-code")).toBeVisible();
		const code = await page.locator("#pairing-code").textContent();
		await expect(follower.locator("#pairing-code")).toHaveText(code);
		await page.close();
		await expect(follower.locator("#pairing-code")).toHaveText(code);
		const context = await browser.newContext();
		await context.addInitScript(installBrowser);
		try {
			const receiver = await context.newPage();
			await receiver.goto(url(kind, app));
			await receive(receiver, code, app);
			await expect(follower.locator("#pairing-approve")).toBeVisible();
			const observer = await context.newPage();
			await observer.goto(url(kind, app));
			const verification = await follower
				.locator("#pairing-verification-code")
				.textContent();
			await expect(observer.locator("#pairing-verification-code")).toHaveText(
				verification,
			);
			await receiver.close();
			await follower.locator("#pairing-approve").click();
			await expect(follower.locator("#pairing-status")).toContainText(
				"New device connected.",
			);
			await expect(observer.locator("#pairing-status")).toContainText(
				"Library connected and unlocked.",
			);
			await expect(observer.locator("#configured")).toBeVisible();
		} finally {
			await context.close();
			await follower.close();
		}
	});
}
