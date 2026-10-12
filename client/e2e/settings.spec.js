import {
	chooseRestore,
	createLibrary,
	downloadRecovery,
	expect,
	fillCreation,
	issueOtc,
	openServer,
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
	expect(JSON.parse(recovery).wrappedKey).toEqual(created.local.wrappedKey);
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
	await page.locator("#restore-pass").press("Enter");
	await expect(page.locator("#status")).toHaveText(
		"Library restored and unlocked.",
	);
	const restored = await storage(page);
	expect(restored.local.publicKey).toBe(created.local.publicKey);
	expect(restored.local.identityGeneration).not.toBe(
		created.local.identityGeneration,
	);
});

test("failed registration retains the encrypted identity for retry and keeps errors beside setup", async ({
	page,
	app,
}) => {
	await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
	await openServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, "invalid-code");
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#status")).toContainText(
		"Your encrypted identity is saved",
	);
	const failed = await storage(page);
	expect(failed.local.pendingRegistration.wrappedKey).toBeTruthy();
	expect(failed.local.pendingRegistration).not.toHaveProperty("password");
	await page.locator("#otc").fill(await issueOtc(app.data));
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#status")).toContainText("Library created.");
	expect((await storage(page)).local.publicKey).toBe(
		failed.local.pendingRegistration.publicKey,
	);
});

test("invalid recovery and invalid server input preserve form drafts and saved configuration", async ({
	page,
	app,
}) => {
	const created = await createLibrary(page, app);
	await openServer(page);
	await page.locator("#server").fill("https://user:pass@example.com");
	await page.getByRole("button", { name: "Update URL" }).click();
	await expect(page.locator("#status")).not.toHaveText("Server URL updated.");
	expect((await storage(page)).local.serverUrl).toBe(created.local.serverUrl);
	await resetLibrary(page);
	await chooseRestore(page);
	await page.locator("#file").setInputFiles({
		name: "bad.json",
		mimeType: "application/json",
		buffer: Buffer.from("{}"),
	});
	await page.locator("#restore-pass").fill(PASSWORD);
	await page.locator("#restore-pass").press("Enter");
	await expect(page.locator("#status")).toContainText("Invalid recovery");
	await expect(page.locator("#restore-pass")).toHaveValue(PASSWORD);
});
