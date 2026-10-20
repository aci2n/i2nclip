import { assertPresent } from "../tests/assert.ts";
import { deferred } from "../tests/helpers.ts";
import { createLibrary, expect, master, shot, test } from "./fixtures.ts";

test("navigation contains views and About remains in Settings", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const nav = page.getByRole("navigation", { name: "Main navigation" });
	await expect(nav.getByRole("link")).toHaveText(["Library", "Settings"]);
	await expect(nav.getByRole("button")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Lock", exact: true }),
	).toBeVisible();
	const lock = page.getByRole("button", { name: "Lock", exact: true });
	await expect(lock).toHaveText("");
	await expect(lock.locator("svg")).toHaveCount(1);
	const about = page.getByRole("button", { name: "About", exact: true });
	await expect(about).toBeVisible();
	await about.click();
	const dialog = page.getByRole("dialog", { name: "About i2nclip" });
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(about).toBeFocused();
	for (const width of [1100, 360, 320]) {
		await page.setViewportSize({ width, height: 800 });
		await nav.scrollIntoViewIfNeeded();
		const tabs = assertPresent(await nav.boundingBox());
		const icon = assertPresent(await lock.boundingBox());
		expect(Math.abs(tabs.x + tabs.width / 2 - width / 2)).toBeLessThanOrEqual(
			1,
		);
		expect(
			Math.abs(tabs.y + tabs.height / 2 - icon.y - icon.height / 2),
		).toBeLessThanOrEqual(1);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await shot(page, `settings-navigation-${width}`);
	}

	await expect(dialog).not.toBeVisible();
	await nav.getByRole("link", { name: "Library", exact: true }).click();
	await expect(about).toHaveCount(0);
});

test("an upload survives navigation through Settings", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const pending = deferred();
	const started = deferred();
	await page.route("**/api/media", async (route) => {
		if (route.request().method() === "POST") {
			started.resolve();
			await pending.promise;
		}
		await route.continue().catch(() => {});
	});
	try {
		await page.getByLabel("Upload", { exact: true }).setInputFiles({
			name: "survives-navigation.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("upload remains owned by the application"),
		});
		await started.promise;
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await page.getByRole("link", { name: "Library", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeDisabled();
		pending.resolve();
		await expect(
			page
				.getByRole("article")
				.getByText("survives-navigation.txt", { exact: true })
				.first(),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeEnabled();
	} finally {
		pending.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("native hash links support keyboard navigation and history without reloading the app", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const nav = page.getByRole("navigation", { name: "Main navigation" });
	const library = nav.getByRole("link", { name: "Library", exact: true });
	const settings = nav.getByRole("link", { name: "Settings", exact: true });
	let documents = 0;
	page.on("request", (request) => {
		if (
			request.isNavigationRequest() &&
			request.resourceType() === "document"
		) {
			documents++;
		}
	});
	await library.click();
	await expect(page).toHaveURL(`${app.origin}/#/library`);
	await expect(page.getByRole("searchbox")).toBeVisible();
	await settings.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(`${app.origin}/#/settings`);
	await expect(settings).toHaveAttribute("aria-current", "page");
	await page.goBack();
	await expect(page.getByRole("searchbox")).toBeVisible();
	await expect(library).toHaveAttribute("aria-current", "page");
	await page.goForward();
	await expect(settings).toHaveAttribute("aria-current", "page");
	expect(documents).toBe(0);
});

test("modified hash-link clicks open an independent tab and preserve the current route", async ({
	page,
	app,
	context,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(page.getByRole("searchbox")).toBeVisible();
	const opened = context.waitForEvent("page");
	await page
		.getByRole("link", { name: "Settings", exact: true })
		.click({ modifiers: ["ControlOrMeta"] });
	const other = await opened;
	try {
		await expect(other).toHaveURL(`${app.origin}/#/settings`);
		await master(other);
		await expect(
			other.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		await expect(page).toHaveURL(`${app.origin}/#/library`);
		await expect(page.getByRole("searchbox")).toBeVisible();
	} finally {
		await other.close();
	}
});
