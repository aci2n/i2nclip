import {
	chooseRestore,
	createLibrary,
	downloadRecovery,
	expect,
	fillCreation,
	issueOtc,
	openSetupServer,
	PASSWORD,
	resetLibrary,
	storage,
	test,
} from "./fixtures.js";

test("setup, recovery export, reset and restoration use durable configuration without exposing the key", async ({
	page,
	app,
}) => {
	const created = await createLibrary(page, app);
	expect(created.session.unlocked).toBe(true);
	expect(created.session).not.toHaveProperty("privateKey");
	const recovery = await downloadRecovery(page);
	expect(JSON.parse(recovery).v).toBe(2);
	expect(recovery).not.toContain(PASSWORD);
	expect(recovery).not.toContain("privateKey");
	await resetLibrary(page);
	expect((await storage(page)).local).not.toHaveProperty("wrappedKey");
	await chooseRestore(page);
	await page.locator("#file").setInputFiles({
		name: "recovery.json",
		mimeType: "application/json",
		buffer: Buffer.from(recovery),
	});
	await page.locator("#restore-pass").fill(PASSWORD);
	await page.locator("#preview-recovery").click();
	await page.locator("#restore").click();
	await expect(page.getByRole("status")).toHaveText(
		"Restored 1 libraries. 0 already saved.",
	);
	const restored = await storage(page);
	expect(restored.local.publicKey).toBe(created.local.publicKey);
	expect(restored.local.configured).toBe(true);
});

test("failed registration retains no identity and keeps errors beside setup", async ({
	page,
	app,
}) => {
	await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
	await openSetupServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, "invalid-code");
	await page.locator("#create-library").click();
	await expect(page.locator("#initial-status")).toContainText(
		"No recovery identity was retained",
	);
	const failed = await storage(page);
	expect(failed.local.configured).toBe(false);
	expect(failed.local).not.toHaveProperty("pendingRegistration");
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).catalog,
	).toHaveLength(0);
	await page.locator("#otc").fill(await issueOtc(app.data));
	await page.locator("#create-library").click();
	await expect(page.locator("#status")).toContainText("Library created.");
	expect((await storage(page)).local.publicKey).toBeTruthy();
});

test("invalid recovery and setup server drafts preserve saved configuration", async ({
	page,
	app,
}) => {
	const created = await createLibrary(page, app);
	await expect(page.locator("#server-details")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Update URL" })).toHaveCount(0);
	await expect(page.locator("#configured")).toContainText(
		created.local.serverUrl,
	);
	await page.locator("#add-library-settings > summary").click();
	await page.locator("#create-tab").click();
	await page.locator("#setup-server").fill("https://user:pass@example.com");
	expect((await storage(page)).local.serverUrl).toBe(created.local.serverUrl);
	await resetLibrary(page);
	await chooseRestore(page);
	await page.locator("#file").setInputFiles({
		name: "bad.json",
		mimeType: "application/json",
		buffer: Buffer.from("{}"),
	});
	await page.locator("#restore-pass").fill(PASSWORD);
	await page.locator("#preview-recovery").click();
	await expect(page.getByRole("alert")).toContainText("Invalid recovery");
	await expect(page.locator("#restore-pass")).toHaveValue("");
});
