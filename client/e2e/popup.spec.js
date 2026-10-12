import {
	createLibrary,
	expect,
	openPopup,
	PASSWORD,
	test,
} from "./fixtures.js";

test("pending pages share one durable upload and preserve tag drafts across navigation", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const source = {
		id: "pending",
		srcUrl: `${app.web.origin}/client/public/icon.svg`,
		name: "icon.svg",
	};
	await page.evaluate(
		(source) => window.serviceTest("context", { source, withTags: true }),
		source,
	);
	const popup = await openPopup(
		page,
		`${app.web.origin}/client/dist/extension/upload.html?id=pending`,
	);
	await expect(popup.locator("#name")).toHaveText("icon.svg");
	await popup.locator("#tags").fill("Draft");
	await popup.getByRole("link", { name: "Settings", exact: true }).click();
	await popup.getByRole("link", { name: "Upload", exact: true }).click();
	await expect(popup.locator("#tags")).toHaveValue("Draft");
	const closed = popup.waitForEvent("close");
	await popup.locator("#send button").click();
	await closed;
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(page.locator(".card-title")).toHaveText("icon.svg");
	await expect(page.locator(".tag-text")).toHaveText(["Draft"]);
});

test("background restart starts locked and retains pending sources for explicit submission", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.evaluate(() =>
		window.serviceTest("context", {
			source: {
				id: "retained",
				srcUrl: `${location.origin}/client/public/icon.svg`,
			},
			withTags: true,
		}),
	);
	await expect
		.poll(() =>
			page.evaluate(
				async () => (await window.serviceTest("state")).uploads[0]?.name,
			),
		)
		.not.toBe("");
	await page.evaluate(() => window.serviceTest("restart"));
	await page.reload();
	await expect(page.locator("#master-password")).toBeVisible();
	const popup = await openPopup(
		page,
		`${app.web.origin}/client/dist/extension/upload.html?id=retained`,
	);
	await expect(popup.locator("#name")).toBeHidden();
	await expect(popup.locator("#preview")).toBeHidden();
	await expect(popup.locator("#send button")).toBeHidden();
	await page.locator("#master-password").fill(PASSWORD);
	await page.locator("#unlock-vault").click();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(page.locator("#files")).toBeAttached();
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).uploads[0].status,
	).toBe("awaiting");
	await expect(popup.locator("#send button")).toBeEnabled();
	const closed = popup.waitForEvent("close");
	await popup.locator("#send button").click();
	await closed;
});
