import {
	expect,
	fillCreation,
	installBrowser,
	issueOtc,
	openServer,
	shot,
	test,
} from "./fixtures.js";
const url = (kind, app, page = "options") =>
	kind === "web"
		? `${app.origin}/?page=${page}`
		: `${app.web.origin}/client/dist/extension/${page}.html`;
async function createPersonal(page, kind, app) {
	await page.goto(url(kind, app));
	await openServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, await issueOtc(app.data));
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#configured")).toBeVisible();
	return page.locator("#library-selector").inputValue();
}
async function add(page, name) {
	await page.getByRole("button", { name: "Add library", exact: true }).click();
	await page.locator("#new-library-name").fill(name);
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await expect(page.locator("#create")).toBeVisible();
	return page.locator("#library-selector").inputValue();
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
		const team = await add(page, "Team");
		await page.locator("#authorizer").selectOption(personal);
		await page.locator("#pass").fill("team-password");
		await page.locator("#pass").press("Enter");
		await expect(page.locator("#configured")).toBeVisible();
		await upload(page, "team.txt");
		await expect(other.locator("#library-selector")).toHaveValue(personal);
		await expect(other.locator(".card-title")).toHaveText("private.txt");
		await other.locator("#library-selector").selectOption(team);
		await expect(other.locator(".card-title")).toHaveText("team.txt");
		await other.reload();
		await expect(other.locator("#library-selector")).toHaveValue(team);
		await page.getByRole("link", { name: "Settings", exact: true }).click();
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
			const incoming = await add(receiver, "Friends here");
			await page.locator("#pairing-settings > summary").click();
			await page.locator("#pairing-start").click();
			await expect(page.locator("#pairing-code")).toBeVisible();
			const code = await page.locator("#pairing-code").textContent();
			await receiver
				.getByRole("button", { name: "Connect existing library", exact: true })
				.click();
			await receiver.locator("#pairing-input").fill(code);
			await receiver
				.locator("#pairing-password")
				.fill("receiver-team-password");
			await receiver
				.getByRole("button", { name: "Connect library", exact: true })
				.click();
			await expect(page.locator("#pairing-approve")).toBeVisible();
			await expect(receiver.locator("#pairing-verification-code")).toHaveText(
				await page.locator("#pairing-verification-code").textContent(),
			);
			await page.locator("#pairing-approve").click();
			await expect(receiver.locator("#configured")).toBeVisible();
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
			receiver.once("dialog", (dialog) => dialog.accept());
			await receiver
				.getByRole("button", { name: "Forget this library", exact: true })
				.click();
			await expect(receiver.locator("#library-selector")).toHaveValue(
				receiverPersonal,
			);
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
