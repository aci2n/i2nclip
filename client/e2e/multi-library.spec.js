import {
	senderPairing,
	receiverPairing,
	assertDocumentIds,
	expect,
	fillCreation,
	installBrowser,
	issueOtc,
	openSetupServer,
	shot,
	test,
} from "./fixtures.js";

const url = (kind, app, page = "options") =>
	kind === "web"
		? `${app.origin}/?page=${page}`
		: `${app.web.origin}/client/dist/extension/${page}.html`;
async function createPersonal(page, kind, app) {
	await page.goto(url(kind, app));
	await openSetupServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, await issueOtc(app.data));
	await page.locator("#create-library").click();
	await expect(page.locator("#configured")).toBeVisible();
	await expect(page.locator("#library-selector")).toHaveCount(0);
	return new URL(page.url()).searchParams.get("library");
}
async function add(page, name) {
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.locator("#add-library-settings > summary").click();
	await page.locator("#new-library-name").fill(name);
	await expect(page.locator("#authorize-tab")).toHaveAttribute(
		"aria-selected",
		"true",
	);
}
async function upload(page, name) {
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.locator("#files")
		.setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(name) });
	await expect(page.locator(".card-title")).toHaveText(name);
}
for (const kind of ["web", "extension"]) {
	test(`${kind} tabs select independent named libraries and pair an additional library without replacing personal data`, async ({
		page,
		app,
		browser,
	}) => {
		const personal = await createPersonal(page, kind, app);
		await upload(page, "private.txt");
		const other = await page.context().newPage();
		await other.goto(url(kind, app, "library"));
		await expect(other.locator(".card-title")).toHaveText("private.txt");
		await add(page, "Team");
		await page.locator("#authorize-library").click();
		await expect
			.poll(() => new URL(page.url()).searchParams.get("library"))
			.not.toBe(personal);
		const team = new URL(page.url()).searchParams.get("library");
		await upload(page, "team.txt");
		await expect(other.locator("#library-selector")).toHaveValue(personal);
		await expect(other.locator(".card-title")).toHaveText("private.txt");
		await other.locator("#library-selector").selectOption(team);
		await expect(other.locator(".card-title")).toHaveText("team.txt");
		await other.reload();
		await expect(other.locator("#library-selector")).toHaveValue(team);
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await expect(page.locator("#rename-library")).toBeHidden();
		await expect(page.locator("#new-library-name")).toBeHidden();
		await page.locator("#rename-library-settings > summary").click();
		await page.locator("#rename-library").fill("Friends");
		await page.getByRole("button", { name: "Rename", exact: true }).click();
		await expect(other.locator("#library-selector option:checked")).toHaveText(
			"Friends",
		);
		const context = await browser.newContext();
		await context.addInitScript(installBrowser);
		try {
			const receiver = await context.newPage();
			const receiverPersonal = await createPersonal(receiver, kind, app);
			await upload(receiver, "receiver-private.txt");
			await add(receiver, "Friends here");
			await senderPairing(page).locator("summary").click();
			await senderPairing(page)
				.getByRole("button", { name: "Create pairing code", exact: true })
				.click();
			await expect(
				senderPairing(page).getByRole("status", {
					name: "Pairing code",
					exact: true,
				}),
			).toBeVisible();
			const code = await senderPairing(page)
				.getByRole("status", { name: "Pairing code", exact: true })
				.textContent();
			await receiver.getByRole("tab", { name: "Pair", exact: true }).click();
			await receiverPairing(receiver)
				.getByRole("textbox", { name: "Pairing code", exact: true })
				.fill(code);
			await receiver
				.getByRole("button", { name: "Connect library", exact: true })
				.click();
			await expect(
				senderPairing(page).getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				}),
			).toBeVisible();
			await assertDocumentIds(receiver);
			await expect(
				receiverPairing(receiver).getByRole("status", {
					name: "Verification code",
					exact: true,
				}),
			).toHaveText(
				await senderPairing(page)
					.getByRole("status", { name: "Verification code", exact: true })
					.textContent(),
			);
			await senderPairing(page)
				.getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				})
				.click();
			await expect
				.poll(() => new URL(receiver.url()).searchParams.get("library"))
				.not.toBe(receiverPersonal);
			const incoming = new URL(receiver.url()).searchParams.get("library");
			await receiver
				.getByRole("link", { name: "Library", exact: true })
				.click();
			await expect(receiver.locator(".card-title")).toHaveText("team.txt");
			await receiver
				.locator("#library-selector")
				.selectOption(receiverPersonal);
			await expect(receiver.locator(".card-title")).toHaveText(
				"receiver-private.txt",
			);
			await receiver.locator("#library-selector").selectOption(incoming);
			await expect(receiver.locator(".card-title")).toHaveText("team.txt");
			await receiver.setViewportSize({ width: 320, height: 800 });
			await shot(receiver, `multi-library-${kind}`);
			await receiver
				.getByRole("link", { name: "Settings", exact: true })
				.click();
			await shot(receiver, `manage-libraries-${kind}`);
			await receiver.locator("#rename-library-settings > summary").click();
			await shot(receiver, `rename-library-${kind}`);
			receiver.once("dialog", (dialog) => dialog.accept());
			await receiver
				.getByRole("button", { name: "Forget this library", exact: true })
				.click();
			await expect(receiver.locator("#library-selector")).toHaveCount(0);
			await expect
				.poll(() => new URL(receiver.url()).searchParams.get("library"))
				.toBe(receiverPersonal);
			await receiver
				.getByRole("link", { name: "Library", exact: true })
				.click();
			await expect(receiver.locator(".card-title")).toHaveText(
				"receiver-private.txt",
			);
		} finally {
			await context.close();
			await other.close();
		}
	});
}

for (const kind of ["web", "extension"]) {
	for (const differentSelection of [false, true]) {
		test(`${kind} duplicate pairing (different selection: ${differentSelection}) selects the existing library in the receiving page`, async ({
			page,
			app,
		}) => {
			const personal = await createPersonal(page, kind, app);
			const original = await page.evaluate(() => window.serviceTest("config"));
			const receiver = await page.context().newPage();
			await receiver.goto(url(kind, app));
			await expect(receiver.locator("#configured")).toBeVisible();
			if (differentSelection) {
				await add(receiver, "Other library");
				await receiver.locator("#authorize-library").click();
				await expect
					.poll(() => new URL(receiver.url()).searchParams.get("library"))
					.not.toBe(personal);
			}
			await add(receiver, "Duplicate draft");
			await receiver.getByRole("tab", { name: "Pair", exact: true }).click();
			await senderPairing(page).locator("summary").click();
			await senderPairing(page)
				.getByRole("button", { name: "Create pairing code", exact: true })
				.click();
			await expect(
				senderPairing(page).getByRole("status", {
					name: "Pairing code",
					exact: true,
				}),
			).toBeVisible();
			await receiverPairing(receiver)
				.getByRole("textbox", { name: "Pairing code", exact: true })
				.fill(
					await senderPairing(page)
						.getByRole("status", { name: "Pairing code", exact: true })
						.textContent(),
				);
			await receiver
				.getByRole("button", { name: "Connect library", exact: true })
				.click();
			await expect(
				senderPairing(page).getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				}),
			).toBeVisible();
			await assertDocumentIds(receiver);
			await expect(
				receiverPairing(receiver).getByRole("status", {
					name: "Verification code",
					exact: true,
				}),
			).toHaveText(
				await senderPairing(page)
					.getByRole("status", { name: "Verification code", exact: true })
					.textContent(),
			);
			await senderPairing(page)
				.getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				})
				.click();
			await expect(
				senderPairing(page).locator(".pairing-status"),
			).toContainText("New device connected");
			await expect(receiver.locator("#status")).toContainText(
				"Existing library selected.",
			);
			expect(new URL(receiver.url()).searchParams.get("library")).toBe(
				personal,
			);
			expect(new URL(page.url()).searchParams.get("library")).toBe(personal);
			expect(
				await receiver.evaluate(() => window.serviceTest("config")),
			).toEqual(original);
			await expect(receiver.locator("#new-library-name")).toBeHidden();
			if (differentSelection) {
				await expect(receiver.locator("#library-selector")).toHaveValue(
					personal,
				);
				await expect(receiver.locator("#library-selector option")).toHaveCount(
					2,
				);
			} else {
				await expect(receiver.locator("#library-selector")).toHaveCount(0);
			}
			await receiver.close();
		});
	}
}
