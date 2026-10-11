import {
	expect,
	fillCreation,
	installBrowser,
	issueOtc,
	openServer,
	PASSWORD,
	png,
	shot,
	test,
} from "./fixtures.js";

function optionsUrl(kind, app) {
	return kind === "web"
		? `${app.origin}/?page=options`
		: `${app.web.origin}/client/dist/extension/options.html`;
}

async function identity(page, kind) {
	return page.evaluate((kind) => {
		if (kind === "extension") return browser.storage.session.get("privateKey");
		return JSON.parse(sessionStorage.getItem("i2nclip") || "{}");
	}, kind);
}

async function setup(page, kind, app) {
	await page.goto(optionsUrl(kind, app));
	await openServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, await issueOtc(app.data));
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#status")).toContainText("Library created.");
}

async function connectForm(page, code, app) {
	await openServer(page);
	await page.locator("#server").fill(app.origin);
	await page
		.getByRole("button", { name: "Connect existing library", exact: true })
		.click();
	await page.locator("#pairing-input").fill(code);
	await page.locator("#pairing-password").fill("different-device-password");
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
	test(`pairing ${from} to ${to} transfers an existing library with a new device password`, async ({
		page,
		app,
		browser,
	}) => {
		await setup(page, from, app);
		const original = await identity(page, from);
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
			const errors = [];
			page.on("pageerror", (error) => errors.push(error.message));
			receiver.on("pageerror", (error) => errors.push(error.message));
			const requests = [];
			for (const device of [page, receiver])
				device.on("request", (request) => {
					if (request.url().includes("/api/pairings"))
						requests.push({
							url: request.url(),
							body: request.postData() || "",
						});
				});
			await receiver.goto(optionsUrl(to, app));
			await page.locator("#pairing-settings > summary").click();
			await page.locator("#pairing-start").click();
			await expect(page.locator("#pairing-code")).toBeVisible();
			const code = await page.locator("#pairing-code").textContent();
			expect(code).toMatch(
				/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/,
			);
			if (from === "web" && to === "web") {
				await page.setViewportSize({ width: 320, height: 800 });
				await shot(page, "pairing-code-320");
			}
			await connectForm(receiver, code.toLowerCase(), app);
			await expect(page.locator("#pairing-approve")).toBeVisible();
			expect((await identity(receiver, to)).privateKey).toBeUndefined();
			if (from === "web" && to === "web") {
				await page.setViewportSize({ width: 360, height: 800 });
				await receiver.setViewportSize({ width: 320, height: 800 });
				await shot(page, "pairing-approval-360");
				await shot(receiver, "pairing-receive-320");
			}
			await page.locator("#pairing-approve").click();
			await expect(receiver.locator("#pairing-status")).toContainText(
				"Library connected and unlocked.",
			);
			await expect(page.locator("#pairing-status")).toHaveText(
				"New device connected.",
			);
			expect((await identity(receiver, to)).privateKey).toBe(
				original.privateKey,
			);
			await receiver
				.getByRole("link", { name: "Library", exact: true })
				.click();
			await expect(receiver.locator(".card-title")).toHaveText("shared.png");
			await receiver.evaluate(async (kind) => {
				if (kind === "extension") await browser.storage.session.clear();
				else sessionStorage.clear();
			}, to);
			await receiver.reload();
			await expect(receiver.locator("#unlock")).toBeVisible();
			await receiver.locator("#pass").fill(PASSWORD);
			await receiver.locator("#pass").press("Enter");
			await expect(receiver.locator("#unlock-status")).toContainText(
				"Wrong password",
			);
			await receiver.locator("#pass").fill("different-device-password");
			await receiver.locator("#pass").press("Enter");
			await expect(receiver.locator(".card-title")).toHaveText("shared.png");
			const secret = code.replaceAll("-", "").slice(4);
			for (const request of requests) {
				expect(request.url).not.toContain(secret);
				expect(request.body).not.toContain(secret);
				expect(request.body).not.toContain(original.privateKey);
				expect(request.body).not.toContain("different-device-password");
			}
			expect(errors).toEqual([]);
		} finally {
			await context.close();
		}
	});
}

test("a wrong pairing secret never installs an identity and requires a fresh code", async ({
	page,
	app,
	browser,
}) => {
	await setup(page, "web", app);
	await page.locator("#pairing-settings > summary").click();
	await page.locator("#pairing-start").click();
	await expect(page.locator("#pairing-code")).toBeVisible();
	const code = await page.locator("#pairing-code").textContent();
	const wrong = `${code.slice(0, -1)}${code.endsWith("2") ? "3" : "2"}`;
	const context = await browser.newContext();
	try {
		const receiver = await context.newPage();
		await receiver.goto(optionsUrl("web", app));
		await connectForm(receiver, wrong, app);
		await expect(receiver.locator("#pairing-status")).toContainText(
			"authentication failed",
		);
		expect((await identity(receiver, "web")).privateKey).toBeUndefined();
		await expect(page.locator("#pairing-status")).toContainText(
			"Pairing ended",
		);
		await expect(page.locator("#pairing-approve")).toHaveCount(0);
		await receiver.setViewportSize({ width: 320, height: 800 });
		await shot(receiver, "pairing-error-320");
	} finally {
		await context.close();
	}
});

test("reset cancels an authenticated pairing before approving the identity transfer", async ({
	page,
	app,
	browser,
}) => {
	await setup(page, "web", app);
	await page.locator("#pairing-settings > summary").click();
	await page.locator("#pairing-start").click();
	await expect(page.locator("#pairing-code")).toBeVisible();
	const code = await page.locator("#pairing-code").textContent();
	const context = await browser.newContext();
	try {
		const receiver = await context.newPage();
		await receiver.goto(optionsUrl("web", app));
		await connectForm(receiver, code, app);
		await expect(page.locator("#pairing-approve")).toBeVisible();
		page.once("dialog", (dialog) => dialog.accept());
		await page.locator("#reset-settings > summary").click();
		await page.locator("#reset").click();
		await expect(page.locator("#pairing-code")).toHaveCount(0);
		await expect(receiver.locator("#pairing-status")).toContainText(
			"Pairing ended",
		);
		expect((await identity(receiver, "web")).privateKey).toBeUndefined();
	} finally {
		await context.close();
	}
});
