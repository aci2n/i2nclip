import {
	senderPairing,
	receiverPairing,
	expect,
	fillCreation,
	installBrowser,
	issueOtc,
	openSetupServer,
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
	await openSetupServer(page);
	await page.locator("#server").fill(app.origin);
	await fillCreation(page, await issueOtc(app.data));
	await page.locator("#create-library").click();
	await expect(page.locator("#status")).toContainText("Library created.");
}
async function receive(page, code, app) {
	await openSetupServer(page);
	await page.locator("#server").fill(app.origin);
	await page.getByRole("tab", { name: "Pair", exact: true }).click();
	await receiverPairing(page)
		.getByRole("textbox", { name: "Pairing code", exact: true })
		.fill(code);
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
			await receive(receiver, code.toLowerCase(), app);
			await expect(
				senderPairing(page).getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				}),
			).toBeVisible();
			const verification = await senderPairing(page)
				.getByRole("status", { name: "Verification code", exact: true })
				.textContent();
			await expect(
				receiverPairing(receiver).getByRole("status", {
					name: "Verification code",
					exact: true,
				}),
			).toHaveText(verification);
			expect(
				(await receiver.evaluate(() => window.serviceTest("state"))).session
					.unlocked,
			).toBe(false);
			if (from === "web" && to === "web") {
				await page.setViewportSize({ width: 320, height: 800 });
				await shot(page, "service-pairing-320");
			}
			await senderPairing(page)
				.getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				})
				.click();
			await expect(
				senderPairing(page).locator(".pairing-status"),
			).toContainText("New device connected");
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
	test(`${kind} sender pairing survives page closure while closing its temporary receiver cancels`, async ({
		page,
		app,
		browser,
	}) => {
		await setup(page, kind, app);
		const follower = await page.context().newPage();
		await follower.goto(url(kind, app));
		await senderPairing(page).locator("summary").click();
		await senderPairing(follower).locator("summary").click();
		await senderPairing(page)
			.getByRole("button", { name: "Create pairing code", exact: true })
			.click();
		await expect(
			senderPairing(page).getByRole("status", {
				name: "Pairing code",
				exact: true,
			}),
		).toBeVisible();
		const firstCode = await senderPairing(page)
			.getByRole("status", { name: "Pairing code", exact: true })
			.textContent();
		await expect(
			senderPairing(follower).getByRole("status", {
				name: "Pairing code",
				exact: true,
			}),
		).toHaveText(firstCode);
		await follower
			.getByRole("button", { name: "Cancel pairing", exact: true })
			.click();
		await expect(senderPairing(page).locator(".pairing-status")).toContainText(
			"canceled",
		);
		await expect(
			senderPairing(follower).locator(".pairing-status"),
		).toContainText("canceled");
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
		await expect(
			senderPairing(follower).getByRole("status", {
				name: "Pairing code",
				exact: true,
			}),
		).toHaveText(code);
		await page.close();
		await expect(
			senderPairing(follower).getByRole("status", {
				name: "Pairing code",
				exact: true,
			}),
		).toHaveText(code);
		const context = await browser.newContext();
		await context.addInitScript(installBrowser);
		try {
			const receiver = await context.newPage();
			await receiver.goto(url(kind, app));
			await receive(receiver, code, app);
			await expect(
				senderPairing(follower).getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				}),
			).toBeVisible();
			const observer = await context.newPage();
			await observer.goto(url(kind, app));
			await expect(
				receiverPairing(observer).getByRole("status", {
					name: "Verification code",
					exact: true,
				}),
			).toHaveCount(0);
			await receiver.close();
			await senderPairing(follower)
				.getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				})
				.click();
			await expect(
				senderPairing(follower).getByRole("button", {
					name: "Create pairing code",
					exact: true,
				}),
			).toBeVisible();
			await expect(
				senderPairing(follower).locator(".pairing-status"),
			).not.toContainText("New device connected.");
			expect(
				(await observer.evaluate(() => window.serviceTest("state"))).catalog,
			).toHaveLength(0);
			await senderPairing(follower)
				.getByRole("button", { name: "Create pairing code", exact: true })
				.click();
			await expect(
				senderPairing(follower).getByRole("status", {
					name: "Pairing code",
					exact: true,
				}),
			).toBeVisible();
			await receive(
				observer,
				await senderPairing(follower)
					.getByRole("status", { name: "Pairing code", exact: true })
					.textContent(),
				app,
			);
			await expect(
				senderPairing(follower).getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				}),
			).toBeVisible();
			await expect(
				receiverPairing(observer).getByRole("status", {
					name: "Verification code",
					exact: true,
				}),
			).toHaveText(
				await senderPairing(follower)
					.getByRole("status", { name: "Verification code", exact: true })
					.textContent(),
			);
			await senderPairing(follower)
				.getByRole("button", {
					name: "Codes match — send library",
					exact: true,
				})
				.click();
			await expect(
				senderPairing(follower).locator(".pairing-status"),
			).toContainText("New device connected.");
			await expect(observer.locator("#configured")).toBeVisible();
		} finally {
			await context.close();
			await follower.close();
		}
	});
}
