import { createLibrary, expect, PASSWORD, test } from "./fixtures.js";

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
	const opening = page.waitForEvent("popup");
	await page.evaluate(
		(url) => window.open(url, "_blank"),
		`${app.web.origin}/client/dist/extension/upload.html?id=pending`,
	);
	const popup = await opening;
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
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(page.locator("#unlock")).toBeVisible();
	await page.locator("#pass").fill(PASSWORD);
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#files")).toBeAttached();
	expect(
		(await page.evaluate(() => window.serviceTest("state"))).uploads[0].status,
	).toBe("awaiting");
	const popup = await page.context().newPage();
	await popup.goto(
		`${app.web.origin}/client/dist/extension/upload.html?id=retained`,
	);
	await expect(popup.locator("#send button")).toBeEnabled();
	const closed = popup.waitForEvent("close");
	await popup.locator("#send button").click();
	await closed;
});
