import {
	createLibrary,
	downloadRecovery,
	expect,
	issueOtc,
	master,
	PASSWORD,
	shot,
	test,
} from "./fixtures.js";

async function add(page, name, method) {
	await page.locator("#add-library-settings > summary").click();
	await page.locator("#new-library-name").fill(name);
	await page.locator(`#${method}-tab`).click();
}
test("four setup tabs support master unlock and fresh invitation attempts", async ({
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
	await page.locator("#add-library-settings > summary").click();
	await expect(page.locator("#new-library-name")).toHaveValue("Personal 2");
	await page.locator("#new-library-name").fill("Authorized");
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
		"No recovery identity was retained",
	);
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).catalog,
	).toHaveLength(2);
	await expect(page.locator("#library-selector option")).toHaveCount(2);
	await page.reload();
	await master(page);
	await page.locator("#add-library-settings > summary").click();
	await expect(page.locator("#new-library-name")).toHaveValue("Personal 2");
	await expect(page.getByRole("button", { name: /Resume setup/ })).toHaveCount(
		0,
	);
	await page.locator("#new-library-name").fill("Invited");
	await page.locator("#create-tab").click();
	await page.locator("#otc").fill(await issueOtc(app.data));
	await page.locator("#create-library").click();
	await expect
		.poll(() => new URL(page.url()).searchParams.get("library"))
		.not.toBe(authorized);
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).catalog,
	).toHaveLength(3);
});

test("setup remains compact and restores a named library using its recovery server", async ({
	page,
	app,
}) => {
	await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
	await master(page);
	await expect(page.locator("#library-name")).toHaveValue("Personal 1");
	await expect(page.getByRole("tab")).toHaveText(["OTC", "Pair", "Restore"]);
	await expect(page.locator("#authorize-panel")).toHaveCount(0);
	await expect(page.locator("#add-library-settings")).toHaveCount(0);
	await expect(page.locator("#settings > :last-child")).toHaveAttribute(
		"id",
		"reset-settings",
	);
	await page.locator("#create-tab").press("ArrowRight");
	await expect(page.locator("#pair-tab")).toBeFocused();
	await page.locator("#pair-tab").press("End");
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
		"Personal 1",
	);
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).session.serverUrl,
	).toBe(app.origin);
});

test("closing and leaving setup clear its drafts; both setup forms fit narrow themes", async ({
	page,
	app,
}) => {
	await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
	await master(page);
	for (const colorScheme of ["light", "dark"]) {
		await page.emulateMedia({ colorScheme });
		for (const width of [320, 360]) {
			await page.setViewportSize({ width, height: 800 });
			await shot(page, `setup-temporary-first-${colorScheme}-${width}`);
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
		}
	}
	await page.locator("#library-name").fill("Unsaved first name");
	await page.locator("#otc").fill("unsaved-code");
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(page.locator("#library-name")).toHaveValue("Personal 1");
	await expect(page.locator("#otc")).toHaveValue("");
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).catalog,
	).toHaveLength(0);
	await createLibrary(page, app);
	await add(page, "Unsaved additional name", "create");
	await page.locator("#otc").fill("unsaved-code");
	await page.locator("#add-library-settings > summary").click();
	await page.locator("#add-library-settings > summary").click();
	await expect(page.locator("#new-library-name")).toHaveValue("Personal 2");
	await page.locator("#create-tab").click();
	await expect(page.locator("#otc")).toHaveValue("");
	for (const colorScheme of ["light", "dark"]) {
		await page.emulateMedia({ colorScheme });
		for (const width of [320, 360]) {
			await page.setViewportSize({ width, height: 800 });
			await shot(page, `setup-temporary-add-${colorScheme}-${width}`);
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
		}
	}
	await page.locator("#new-library-name").fill("Another draft");
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.locator("#add-library-settings > summary").click();
	await expect(page.locator("#new-library-name")).toHaveValue("Personal 2");
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).catalog,
	).toHaveLength(1);
});
