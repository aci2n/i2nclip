import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BrowserContext, chromium, firefox } from "@playwright/test";
import {
	createLibrary,
	expect,
	master,
	openUploadPreferences,
	PASSWORD,
	shot,
	test,
} from "./fixtures.ts";

test("remembered access survives all tabs closing, refresh and a real browser restart", async ({
	app,
}, testInfo) => {
	const directory = await mkdtemp(path.join(tmpdir(), "i2nclip-session-"));
	const browserType = testInfo.project.name === "firefox" ? firefox : chromium;
	let context: BrowserContext | undefined;
	const launch = () =>
		browserType.launchPersistentContext(directory, {
			headless: true,
			...(testInfo.project.name === "firefox"
				? {
						firefoxUserPrefs: { "security.sandbox.content.level": 0 },
						env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" },
					}
				: {}),
		});
	try {
		context = await launch();
		const page = context.pages()[0] ?? (await context.newPage());
		await createLibrary(page, app, undefined, true);
		const publicKey = await page.locator("code").textContent();
		await openUploadPreferences(page);
		await page
			.getByRole("checkbox", { name: "Compress images to WebP" })
			.uncheck();
		// Wait for the preference transaction rather than navigating mid-save.
		await expect(
			page.getByRole("checkbox", { name: "Compress images to WebP" }),
		).toBeEnabled();
		await page.getByText("Change master password", { exact: true }).click();
		await page
			.getByLabel("Current master password", { exact: true })
			.fill(PASSWORD);
		await page
			.getByLabel("New master password", { exact: true })
			.fill("changed-password");
		await page
			.getByLabel("Confirm new master password", { exact: true })
			.fill("changed-password");
		await page
			.getByRole("button", { name: "Change password", exact: true })
			.click();
		await expect(
			page.getByRole("status").filter({ hasText: "Master password changed." }),
		).toBeVisible();
		await page.reload();
		await expect(
			page.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		// Keep the browser alive with an unrelated document while all app tabs close.
		const blank = await context.newPage();
		await page.close();
		await blank.goto(`${app.origin}/#/settings`);
		await expect(
			blank.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		await context.close();
		context = await launch();
		const restored = context.pages()[0] ?? (await context.newPage());
		await restored.goto(`${app.origin}/#/settings`);
		await expect(
			restored.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		await expect(restored.locator("code")).toHaveText(publicKey ?? "");
		await openUploadPreferences(restored);
		await expect(
			restored.getByRole("checkbox", { name: "Compress images to WebP" }),
		).not.toBeChecked();
		const other = await context.newPage();
		await other.goto(`${app.origin}/#/settings`);
		await expect(
			other.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		await restored.getByRole("button", { name: "Lock", exact: true }).click();
		await expect(
			restored.getByRole("button", { name: "Unlock", exact: true }),
		).toBeVisible();
		await expect(
			other.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		await other.getByRole("link", { name: "Library", exact: true }).click();
		await expect(other.getByRole("searchbox")).toBeVisible();
		await other.reload();
		await expect(
			other.getByRole("button", { name: "Unlock", exact: true }),
		).toBeVisible();
		for (const width of [320, 360]) {
			await restored.setViewportSize({ width, height: 800 });
			await expect(
				restored.getByRole("checkbox", { name: "Remember this device" }),
			).not.toBeChecked();
			await shot(restored, `remember-unlock-${width}`);
		}
		await restored
			.getByLabel("Master password", { exact: true })
			.fill("changed-password");
		await restored.getByRole("button", { name: "Unlock", exact: true }).click();
		await expect(
			restored.getByRole("navigation", { name: "Main navigation" }),
		).toBeVisible();
		for (const width of [320, 360]) {
			await restored.setViewportSize({ width, height: 800 });
			await shot(restored, `lock-settings-${width}`);
		}
		await context.close();
		context = await launch();
		const locked = context.pages()[0] ?? (await context.newPage());
		await locked.goto(`${app.origin}/#/settings`);
		await expect(
			locked.getByRole("button", { name: "Unlock", exact: true }),
		).toBeVisible();
	} finally {
		await context?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("old localStorage is ignored and unremembered access is confined to one tab", async ({
	page,
	app,
}) => {
	await page.goto(app.origin);
	await page.evaluate(() => {
		localStorage.setItem("i2nclip.identity", "old-format-identity");
		localStorage.setItem("i2nclip.compress-images", "old-preference");
	});
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Create master password", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Remember this device" }),
	).not.toBeChecked();
	await master(page);
	const other = await page.context().newPage();
	try {
		await other.goto(app.origin);
		await expect(
			other.getByRole("button", { name: "Unlock", exact: true }),
		).toBeVisible();
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Unlock", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("checkbox", { name: "Remember this device" }),
		).not.toBeChecked();
		await page.getByLabel("Master password", { exact: true }).fill(PASSWORD);
		await page.getByRole("checkbox", { name: "Remember this device" }).check();
		await page.getByRole("button", { name: "Unlock", exact: true }).click();
		await expect(
			page.getByRole("navigation", { name: "Main navigation" }),
		).toBeVisible();
		// Existing locked tabs do not adopt newly remembered access until refresh.
		await expect(
			other.getByRole("button", { name: "Unlock", exact: true }),
		).toBeVisible();
		await other.reload();
		await expect(
			other.getByRole("navigation", { name: "Main navigation" }),
		).toBeVisible();
	} finally {
		await other.close();
	}
});

test("invalid remembered access permits password recovery and damaged storage offers Retry and Reset", async ({
	page,
	app,
}) => {
	await createLibrary(page, app, undefined, true);
	await openUploadPreferences(page);
	const compression = page.getByRole("checkbox", {
		name: "Compress images to WebP",
	});
	await compression.uncheck();
	await expect(compression).toBeEnabled();
	async function damageSession(invalidKey: boolean) {
		await page.evaluate(
			(invalidKey) =>
				new Promise<void>((resolve, reject) => {
					const request = indexedDB.open("i2nclip", 1);
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const db = request.result;
						const tx = db.transaction("state", "readwrite");
						const store = tx.objectStore("state");
						const read = store.get("session");
						read.onsuccess = () =>
							store.put(
								invalidKey ? { ...read.result, key: "invalid" } : null,
								"session",
							);
						tx.oncomplete = () => {
							db.close();
							resolve();
						};
						tx.onabort = () => {
							db.close();
							reject(tx.error);
						};
					};
				}),
			invalidKey,
		);
	}
	await damageSession(true);
	await page.reload();
	await expect(page.getByRole("alert")).toContainText(
		"Remembered access could not be restored",
	);
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await shot(page, `remember-failure-${width}`);
	}
	await master(page);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeVisible();
	await damageSession(false);
	await page.reload();
	await expect(page.getByRole("alert")).toContainText("Invalid saved identity");
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Invalid saved identity");
	await shot(page, "storage-error-360");
	await page.getByText("Reset this client", { exact: true }).click();
	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: "Reset client", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Create master password", exact: true }),
	).toBeVisible();
	await master(page);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await openUploadPreferences(page);
	await expect(compression).not.toBeChecked();
});
