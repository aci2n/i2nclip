import {
	createLibrary,
	master,
	downloadRecovery,
	expect,
	issueOtc,
	PASSWORD,
	shot,
	test,
} from "./fixtures.js";

async function add(page, name, method) {
	await page.locator("#add-library-settings > summary").click();
	await page.locator("#new-library-name").fill(name);
	await page.locator(`#${method}-tab`).click();
}
test("four setup tabs support master unlock and durable invitation retries", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const personal = new URL(page.url()).searchParams.get("library");
	await page.evaluate(() => window.serviceTest("restart"));
	await page.reload();
	await page.locator("#master-password").fill("wrong-password");
	await page.locator("#unlock-vault").click();
	await expect(page.getByRole("alert")).toBeVisible();
	await master(page);
	await add(page, "Authorized", "authorize");
	await expect(page.locator("#authorizer-unlock")).toHaveCount(0);
	await expect(page.locator("#library-selector")).toHaveCount(0);
	await page.locator("#authorize-library").click();
	await expect
		.poll(() => new URL(page.url()).searchParams.get("library"))
		.not.toBe(personal);
	const authorized = new URL(page.url()).searchParams.get("library");
	await add(page, "Invited", "create");
	await page.locator("#otc").fill("invalid-invitation");
	await page.locator("#create-library").click();
	await expect(page.locator("#add-library-settings #status")).toContainText(
		"Your encrypted identity is saved",
	);
	const pending = await page.evaluate(async () => {
		const state = await window.serviceTest("state");
		const row = state.setups.find((row) => row.name === "Invited");
		return {
			id: row.id,
			publicKey: state.libraries[row.id].session.pendingRegistration.publicKey,
		};
	});
	await expect(page.locator("#library-selector option")).toHaveCount(2);
	await page.reload();
	await master(page);
	await page.locator("#add-library-settings > summary").click();
	await page
		.getByRole("button", { name: "Resume setup: Invited", exact: true })
		.click();
	await expect(page.locator("#create-tab")).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await page.locator("#otc").fill(await issueOtc(app.data));
	await page.locator("#create-library").click();
	await expect
		.poll(() => new URL(page.url()).searchParams.get("library"))
		.toBe(pending.id);
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).session.publicKey,
	).toBe(pending.publicKey);
	expect(new URL(page.url()).searchParams.get("library")).not.toBe(authorized);
});

test("setup remains compact and restores a named library using its recovery server", async ({
	page,
	app,
}) => {
	await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
	await master(page);
	await expect(page.getByRole("tab")).toHaveText([
		"OTC",
		"Authorize",
		"Pair",
		"Restore",
	]);
	await expect(page.locator("#add-library-settings")).toHaveCount(0);
	await expect(page.locator("#settings > :last-child")).toHaveAttribute(
		"id",
		"reset-settings",
	);
	await page.locator("#create-tab").press("ArrowRight");
	await expect(page.locator("#authorize-tab")).toBeFocused();
	await page.locator("#authorize-tab").press("End");
	await expect(page.locator("#restore-tab")).toBeFocused();
	await page.setViewportSize({ width: 320, height: 800 });
	await shot(page, "setup-first-320");
	await createLibrary(page, app);
	const recovery = await downloadRecovery(page);
	const original = new URL(page.url()).searchParams.get("library");
	await add(page, "Independent", "authorize");
	await page.locator("#authorize-library").click();
	await expect
		.poll(() => new URL(page.url()).searchParams.get("library"))
		.not.toBe(original);
	await page.locator("#library-selector").selectOption(original);
	await page.locator("#rename-library-settings > summary").click();
	page.once("dialog", (dialog) => dialog.accept());
	await page
		.getByRole("button", { name: "Forget this library", exact: true })
		.click();
	await expect(page.locator("#library-selector")).toHaveCount(0);
	await add(page, "Restored", "restore");
	await page.locator("#file").setInputFiles({
		name: "recovery.json",
		mimeType: "application/json",
		buffer: Buffer.from(recovery),
	});
	await page.locator("#restore-pass").fill(PASSWORD);
	await shot(page, "setup-restore-320");
	await page.locator("#preview-recovery").click();
	await page.locator("#restore").click();
	await expect(page.locator("#library-selector option:checked")).toHaveText(
		"Personal",
	);
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).session.serverUrl,
	).toBe(app.origin);
});
