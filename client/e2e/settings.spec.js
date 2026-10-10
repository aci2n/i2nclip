import {
	chooseRestore,
	createLibrary,
	DEFAULT_SERVER,
	downloadRecovery,
	expect,
	expectConfigured,
	expectSetup,
	expireOtc,
	fillCreation,
	issueOtc,
	openReset,
	openServer,
	options,
	PASSWORD,
	png,
	resetLibrary,
	shot,
	storage,
	test,
} from "./fixtures.js";

test("create, reset, recover, unlock, upload, and both color schemes", async ({
	page,
	app,
}) => {
	const { data, origin, web } = app;
	await page.goto(`${web.origin}/client/dist/extension/library.html`);
	await expect(page.locator("#setup")).toBeVisible();
	await shot(page, "library-empty");

	await page.goto(`${web.origin}/client/dist/extension/options.html`);
	await expect(
		page.getByRole("button", { name: "Create library" }),
	).toBeVisible();
	await expect(page.locator("textarea")).toHaveCount(0);
	await expect(page.locator('#create input[type="password"]')).toHaveCount(1);
	await shot(page, "options");

	await openServer(page);

	await page.locator("#server").fill(origin);
	await page.locator("#pass").fill("test-pass-1");
	await page.locator("#otc").fill("invalid-invitation");
	await page
		.getByRole("button", { name: "Create library", exact: true })
		.click();
	await expect(page.locator("#status")).toContainText("Registration failed");
	await expect(page.locator("#create")).toBeVisible();
	await expect(page.locator("#restore-settings")).toBeHidden();
	await expect(page.locator("#configured")).toBeHidden();
	await expect(page.locator("#reset-settings")).toBeHidden();
	expect(
		await page.evaluate(
			() => JSON.parse(localStorage.getItem("i2nclip-e2e") || "{}").wrappedKey,
		),
	).toBeUndefined();
	expect(
		await page.evaluate(
			() =>
				JSON.parse(sessionStorage.getItem("i2nclip-e2e") || "{}").privateKey,
		),
	).toBeUndefined();
	const otc = await issueOtc(data);
	await page.locator("#otc").fill(otc);
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#status")).toContainText("Library created.");
	await expect(page.locator("#create")).toBeHidden();
	await expect(page.locator("#registration")).toHaveCount(0);
	const identity = await page.evaluate(
		() => JSON.parse(localStorage.getItem("i2nclip-e2e")).publicKey,
	);
	await page.getByRole("button", { name: "Download recovery file" }).click();
	await expect(page.locator("#status")).toContainText(
		"Recovery download started",
	);
	const recovery = await page.evaluate(() => window.lastDownload);
	expect(JSON.parse(recovery).wrappedKey.ct).toBeTruthy();
	await shot(page, "options-configured");

	await page.getByRole("link", { name: "Library" }).click();
	await expect(
		page.getByRole("heading", { name: "Your library is empty", exact: true }),
	).toBeVisible();
	await page
		.locator("#files")
		.setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
	await expect(page.locator(".card strong")).toHaveText("dot.png");
	await expect(page.locator(".card img")).toBeVisible();
	await page.locator(".card img").click();
	await expect(page.locator(".card .media img")).toBeVisible();
	await expect(page.locator("#full img")).toBeVisible();
	await page.locator("#full").click({ position: { x: 2, y: 2 } });
	await shot(page, "library-card");

	// Reset the configured library, then recover and decrypt the existing upload.
	await page.goto(`${web.origin}/client/dist/extension/options.html`);
	await expect(page.locator("#restore-settings")).toBeHidden();
	page.once("dialog", (dialog) => dialog.dismiss());
	await openReset(page);
	await page
		.getByRole("button", { name: "Reset everything", exact: true })
		.click();
	await expect(page.locator("#configured")).toBeVisible();
	await expect(page.locator("#restore-settings")).toBeHidden();
	expect(
		await page.evaluate(
			() => JSON.parse(localStorage.getItem("i2nclip-e2e")).wrappedKey,
		),
	).toBeTruthy();
	page.once("dialog", (dialog) => dialog.accept());
	await openReset(page);
	await page
		.getByRole("button", { name: "Reset everything", exact: true })
		.click();
	await expect(page.locator("#status")).toContainText("Browser settings reset");
	await expect(page.locator("#create")).toBeVisible();
	await expect(page.locator("#restore-settings")).toBeHidden();
	await expect(page.locator("#configured")).toBeHidden();
	expect(
		await page.evaluate(() => localStorage.getItem("i2nclip-e2e")),
	).toBeNull();
	expect(
		await page.evaluate(() => sessionStorage.getItem("i2nclip-e2e")),
	).toBeNull();
	await chooseRestore(page);
	await page.locator("#file").setInputFiles({
		name: "i2nclip-recovery.json",
		mimeType: "application/json",
		buffer: Buffer.from(recovery),
	});
	await page.locator("#restore-pass").fill("wrong-password");
	await page
		.getByRole("button", { name: "Restore library", exact: true })
		.click();
	await expect(page.locator("#status")).toContainText("Wrong password");
	await expect(page.locator("#restore-settings")).toBeVisible();
	await page.locator("#restore-pass").fill("test-pass-1");
	await page.locator("#restore-pass").press("Enter");
	await expect(page.locator("#status")).toHaveText(
		"Library restored and unlocked.",
	);
	await expect(page.locator("#restore-settings")).toBeHidden();
	expect(
		await page.evaluate(
			() => JSON.parse(localStorage.getItem("i2nclip-e2e")).publicKey,
		),
	).toBe(identity);
	await page.evaluate(() => browser.storage.session.clear());
	await page.getByRole("link", { name: "Library" }).click();
	await expect(page.locator("#unlock")).toBeVisible();
	await page.locator('#unlock input[type="password"]').fill("test-pass-1");
	await page.locator('#unlock button[type="submit"]').click();
	await expect(page.locator(".card strong")).toHaveText("dot.png");
	await page.locator(".card img").click();
	await expect(page.locator("#full img")).toBeVisible();
});

test("fresh setup defaults to the public server", async ({ page, app }) => {
	await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
	await expect(page.locator("#server")).toHaveValue(DEFAULT_SERVER);
	await expectSetup(page);
	expect(await storage(page)).toEqual({ local: {}, session: {} });
});

for (const submit of ["click", "Enter"]) {
	for (const accepted of [false, true]) {
		test(`pending registration stores no identity: ${submit}, ${accepted ? "accepted" : "rejected"}`, async ({
			page,
			app,
		}) => {
			await options(page, app);
			await fillCreation(
				page,
				accepted ? await issueOtc(app.data) : "invalid-code",
			);
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			let requests = 0;
			let payload;
			await page.route("**/api/register-key", async (route) => {
				requests++;
				payload = route.request().postDataJSON();
				await gate;
				await route.continue();
			});
			const before = await storage(page);
			if (submit === "click") await page.locator("#create-library").click();
			else await page.locator("#pass").press("Enter");
			try {
				await expect.poll(() => requests).toBe(1);
				await expect(page.locator("#create-library")).toBeDisabled();
				await expectSetup(page);
				expect(await storage(page)).toEqual(before);
				expect(Object.keys(payload).sort()).toEqual(["otc", "public_key"]);
				// Submitting a busy form again must not consume another invitation.
				await page.locator("#create").evaluate((form) => form.requestSubmit());
				expect(await storage(page)).toEqual(before);
			} finally {
				release();
			}
			await expect(page.locator("#status")).toContainText(
				accepted ? "Library created." : "Registration failed",
			);
			expect(requests).toBe(1);
			if (accepted) {
				await expectConfigured(page);
				expect((await storage(page)).local.publicKey).toBe(payload.public_key);
			} else {
				await expectSetup(page);
				expect(await storage(page)).toEqual(before);
			}
		});
	}
}

const invalidCreation = [
	["missing server", "server", "", "valueMissing"],
	["invalid server", "server", "not-a-url", "typeMismatch"],
	["missing invitation", "otc", "", "valueMissing"],
	["missing password", "pass", "", "valueMissing"],
	["short password", "pass", "1234567", "tooShort"],
];

for (const [name, field, value, validity] of invalidCreation) {
	test(`creation validation: ${name}`, async ({ page, app }) => {
		await options(page, app);
		await fillCreation(page, "unused-code");
		// Keyboard input makes minlength validation behave as it does for a user.
		await page.locator(`#${field}`).fill("");
		if (value) await page.locator(`#${field}`).pressSequentially(value);
		let registrations = 0;
		page.on("request", (request) => {
			if (
				request.method() === "POST" &&
				request.url().endsWith("/api/register-key")
			)
				registrations++;
		});
		const before = await storage(page);
		await page
			.getByRole("button", { name: "Create library", exact: true })
			.click();
		await expect
			.poll(() =>
				page
					.locator(`#${field}`)
					.evaluate((input, flag) => input.validity[flag], validity),
			)
			.toBe(true);
		await expectSetup(page);
		expect(await storage(page)).toEqual(before);
		expect(registrations).toBe(0);
	});
}

for (const failure of [
	"invalid code",
	"expired code",
	"used code",
	"network error",
	"server error",
	"lost response",
	"whitespace code",
]) {
	test(`registration failure leaves no identity: ${failure}`, async ({
		page,
		app,
	}) => {
		await options(page, app);
		let code = "invalid-code";
		if (failure === "expired code") {
			code = await issueOtc(app.data);
			await expireOtc(app.data);
		} else if (failure === "used code") {
			({ code } = await createLibrary(page, app));
			await resetLibrary(page);
			await openServer(page);
			await page.locator("#server").fill(app.origin);
		} else if (failure === "whitespace code") {
			code = "   ";
		} else if (
			["network error", "server error", "lost response"].includes(failure)
		) {
			code = await issueOtc(app.data);
			await page.route("**/api/register-key", async (route) => {
				if (failure === "server error")
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: '{"error":"test server error"}',
					});
				else {
					if (failure === "lost response") await route.fetch();
					await route.abort("failed");
				}
			});
		}
		await fillCreation(page, code);
		const before = await storage(page);
		await page.locator("#pass").press("Enter");
		await expect(page.locator("#status")).toContainText(
			failure === "whitespace code"
				? "Enter an invitation code"
				: "Registration failed",
		);
		await expectSetup(page);
		expect(await storage(page)).toEqual(before);
		// A valid retry succeeds without requiring reset.
		await page.unroute("**/api/register-key");
		await page.locator("#otc").fill(await issueOtc(app.data));
		await page.locator("#pass").press("Enter");
		await expect(page.locator("#status")).toContainText("Library created.");
		await expectConfigured(page);
	});
}

for (const theme of ["light", "dark"]) {
	for (const state of ["empty", "locked", "unlocked"]) {
		test(`settings visibility and recovery download: ${state}, ${theme}`, async ({
			page,
			app,
		}) => {
			await page.emulateMedia({ colorScheme: theme });
			await options(page, app);
			if (state === "empty") {
				await expectSetup(page);
				await expect(page.locator("#reset")).toBeHidden();
				await expect(page.locator("#backup")).toBeHidden();
			} else {
				const created = await createLibrary(page, app);
				if (state === "locked")
					await page.evaluate(() => browser.storage.session.clear());
				await page.reload();
				await expectConfigured(page);
				const before = await storage(page);
				const recovery = JSON.parse(await downloadRecovery(page));
				expect(recovery.serverUrl).toBe(app.origin);
				expect(recovery.wrappedKey).toEqual(created.local.wrappedKey);
				expect(recovery).not.toHaveProperty("privateKey");
				expect(JSON.stringify(recovery)).not.toContain(
					JSON.parse(created.session.privateKey).seed,
				);
				expect(await storage(page)).toEqual(before);
				await page.getByRole("link", { name: "Library" }).click();
				if (state === "locked")
					await expect(page.locator("#unlock")).toBeVisible();
				else {
					await expect(page.locator("#unlock")).toBeHidden();
					await expect(
						page.getByRole("heading", {
							name: "Your library is empty",
							exact: true,
						}),
					).toBeVisible();
				}
			}
		});
	}
}

for (const state of ["locked", "unlocked"]) {
	for (const accept of [false, true]) {
		test(`reset ${accept ? "confirmed" : "cancelled"}: ${state}`, async ({
			page,
			app,
		}) => {
			await createLibrary(page, app);
			if (state === "locked")
				await page.evaluate(() => browser.storage.session.clear());
			await page.reload();
			const before = await storage(page);
			await resetLibrary(page, accept);
			if (accept) {
				await expectSetup(page);
				await expect(page.locator("#server")).toHaveValue(DEFAULT_SERVER);
				expect(await storage(page)).toEqual({ local: {}, session: {} });
				await page.reload();
				await expectSetup(page);
			} else {
				await expectConfigured(page);
				expect(await storage(page)).toEqual(before);
				await page.reload();
				await expectConfigured(page);
			}
		});
	}
}

for (const failure of [
	"missing file",
	"missing password",
	"malformed JSON",
	"wrong format",
	"wrong version",
	"invalid server",
	"invalid envelope",
	"excessive iterations",
	"oversized file",
	"wrong password",
	"damaged ciphertext",
	"mismatched identity",
]) {
	test(`recovery failure preserves setup: ${failure}`, async ({
		page,
		app,
	}) => {
		const created = await createLibrary(page, app);
		let recovery = await downloadRecovery(page);
		await resetLibrary(page);
		await chooseRestore(page);
		const document = JSON.parse(recovery);
		if (failure === "malformed JSON") recovery = "not JSON";
		if (failure === "wrong format") document.format = "other-format";
		if (failure === "wrong version") document.v = 2;
		if (failure === "invalid server")
			document.serverUrl = "javascript:alert(1)";
		if (failure === "invalid envelope") document.wrappedKey.salt = "AAAA";
		if (failure === "excessive iterations")
			document.wrappedKey.iterations = 9_000_000;
		if (failure === "damaged ciphertext") {
			const bytes = Buffer.from(document.wrappedKey.ct, "base64");
			bytes[0] ^= 1;
			document.wrappedKey.ct = bytes.toString("base64");
		}
		if (failure === "mismatched identity") {
			document.wrappedKey = await page.evaluate(
				async ({ privateKey, password }) => {
					const { generatePrivateKey } = await import(
						"/client/src/lib/protocol/identity.js"
					);
					const { wrapPrivateKey } = await import(
						"/client/src/lib/protocol/vault.js"
					);
					const other = await generatePrivateKey();
					const mismatched = {
						...JSON.parse(privateKey),
						publicKey: other.publicKey,
					};
					return wrapPrivateKey(JSON.stringify(mismatched), password);
				},
				{ privateKey: created.session.privateKey, password: PASSWORD },
			);
		}
		if (failure !== "malformed JSON") recovery = JSON.stringify(document);
		if (failure === "oversized file") recovery = " ".repeat(16_385);
		if (failure !== "missing file")
			await page.locator("#file").setInputFiles({
				name: "recovery.json",
				mimeType: "application/json",
				buffer: Buffer.from(recovery),
			});
		await page
			.locator("#restore-pass")
			.fill(
				failure === "missing password"
					? ""
					: failure === "wrong password"
						? "wrong-password"
						: PASSWORD,
			);
		// Saving a server URL also verifies a failed restore preserves existing settings.
		await openServer(page);
		await page.locator("#server").fill(app.origin);
		await page.locator("#save-server").click();
		const before = await storage(page);
		await page.locator("#restore").click();
		if (failure === "missing file" || failure === "missing password") {
			const input = page.locator(
				failure === "missing file" ? "#file" : "#restore-pass",
			);
			expect(await input.evaluate((input) => input.validity.valueMissing)).toBe(
				true,
			);
		} else {
			await expect(page.locator("#status")).toContainText(
				failure === "mismatched identity"
					? "does not match"
					: ["wrong password", "damaged ciphertext"].includes(failure)
						? "Wrong password"
						: "Invalid",
			);
		}
		await expectSetup(page);
		expect(await storage(page)).toEqual(before);
	});
}

for (const submit of ["click", "Enter"]) {
	test(`restore succeeds without registration: ${submit}`, async ({
		page,
		app,
	}) => {
		const created = await createLibrary(page, app);
		const recovery = await downloadRecovery(page);
		await resetLibrary(page);
		await chooseRestore(page);
		await page.route("**/api/register-key", () => {
			throw new Error("Restore must not register again");
		});
		await page.locator("#file").setInputFiles({
			name: "recovery.json",
			mimeType: "application/json",
			buffer: Buffer.from(recovery),
		});
		await page.locator("#restore-pass").fill(PASSWORD);
		if (submit === "click") await page.locator("#restore").click();
		else await page.locator("#restore-pass").press("Enter");
		await expect(page.locator("#status")).toHaveText(
			"Library restored and unlocked.",
		);
		await expectConfigured(page);
		const restored = await storage(page);
		expect(restored.local).toEqual(created.local);
		expect(restored.session.privateKey).toBe(created.session.privateKey);
		await page.reload();
		await expectConfigured(page);
		await expect(page.locator("#server")).toHaveValue(app.origin);
	});
}

for (const state of ["locked", "unlocked"]) {
	test(`server update preserves library: ${state}`, async ({ page, app }) => {
		await createLibrary(page, app);
		if (state === "locked")
			await page.evaluate(() => browser.storage.session.clear());
		await page.reload();
		const before = await storage(page);
		await openServer(page);
		await page.locator("#server").fill("not-a-url");
		await page.locator("#save-server").click();
		expect(await storage(page)).toEqual(before);
		const serverUrl = "https://new.example.com";
		await openServer(page);
		await page.locator("#server").fill(serverUrl);
		await page.locator("#server").press("Enter");
		await expect(page.locator("#status")).toHaveText("Server URL updated.");
		expect(await storage(page)).toEqual({
			local: { ...before.local, serverUrl },
			session: before.session,
		});
		expect(JSON.parse(await downloadRecovery(page)).serverUrl).toBe(serverUrl);
		await page.reload();
		await expect(page.locator("#server")).toHaveValue(serverUrl);
		await expectConfigured(page);
	});
}

for (const password of ["wrong-password", PASSWORD]) {
	test(`unlock ${password === PASSWORD ? "succeeds" : "fails"} without modifying the saved identity`, async ({
		page,
		app,
	}) => {
		await createLibrary(page, app);
		await page.evaluate(() => browser.storage.session.clear());
		const before = await storage(page);
		await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
		await expect(page.locator("#unlock")).toBeVisible();
		await page.locator("#pass").fill(password);
		await page.locator("#pass").press("Enter");
		if (password === PASSWORD) {
			await expect(page.locator("#unlock")).toBeHidden();
			await expect(
				page.getByRole("heading", {
					name: "Your library is empty",
					exact: true,
				}),
			).toBeVisible();
			expect((await storage(page)).session.privateKey).toBeTruthy();
		} else {
			await expect(page.locator("#unlock-status")).toContainText(
				"Wrong password",
			);
			await expect(page.locator("#unlock")).toBeVisible();
			expect((await storage(page)).session).toEqual(before.session);
		}
		expect((await storage(page)).local).toEqual(before.local);
	});
}

test("setup errors stay beside the active form on narrow screens", async ({
	page,
	app,
}) => {
	await page.setViewportSize({ width: 360, height: 740 });
	await options(page, app);
	await page.locator("#server-details > summary").click();
	await fillCreation(page, "invalid-invitation");
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#create #status")).toContainText(
		"Registration failed",
	);
	await expect(page.locator("#create #status")).toBeInViewport();
	await expect(page.locator("#create #status")).toHaveAttribute(
		"role",
		"alert",
	);
	await expect(page.locator("#restore-settings")).toBeHidden();
	expect(
		await page.locator("#server-details").evaluate((element) => element.open),
	).toBe(false);
	await shot(page, "setup-error-narrow");
	await chooseRestore(page);
	await expect(page.locator("#create #status")).toBeHidden();
	await shot(page, "restore-narrow");
	const restoreTab = page.getByRole("tab", { name: "Restore", exact: true });
	const createTab = page.getByRole("tab", { name: "Create", exact: true });
	await restoreTab.focus();
	await restoreTab.press("ArrowLeft");
	await expect(createTab).toBeFocused();
	await expect(createTab).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByRole("tabpanel", { name: "Create", exact: true }),
	).toBeVisible();
	await createTab.press("End");
	await expect(restoreTab).toBeFocused();
	await expect(restoreTab).toHaveAttribute("aria-selected", "true");
	await restoreTab.press("Home");
	await expect(createTab).toBeFocused();
});
