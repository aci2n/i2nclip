import { readFile } from "node:fs/promises";
import {
	expect,
	installBrowser,
	issueOtc,
	master,
	openServer,
	PASSWORD,
	shot,
	test,
} from "./fixtures.js";

const url = (kind, app, page = "options") =>
	kind === "web"
		? `${app.origin}/?page=${page}`
		: `${app.web.origin}/client/dist/extension/${page}.html`;
for (const kind of ["web", "extension"]) {
	test(`${kind} master password gates all tabs and whole-vault recovery uses a separate password`, async ({
		page,
		app,
		browser,
	}) => {
		await page.goto(url(kind, app));
		await expect(page.locator("#master-confirmation")).toBeVisible();
		await page.setViewportSize({ width: 320, height: 800 });
		await shot(page, `vault-create-${kind}-320`);
		await openServer(page);
		await page.locator("#server").fill(app.origin);
		await page.locator("#otc").fill(await issueOtc(app.data));
		await page.locator("#create-library").click();
		await expect(page.locator("#configured")).toBeVisible();
		await page.locator("#add-library-settings > summary").click();
		await page.locator("#new-library-name").fill("Team");
		await expect(page.locator("#authorize-pass")).toHaveCount(0);
		await page.locator("#authorize-library").click();
		await expect(page.locator("#library-selector option")).toHaveCount(2);
		const other = await page.context().newPage();
		await other.goto(url(kind, app, "library"));
		await expect(other.locator("#files")).toBeAttached();
		await page.locator("#vault-recovery-settings > summary").click();
		await page
			.locator("#vault-recovery-password")
			.fill("offline-backup-password");
		await page
			.locator("#vault-recovery-confirm")
			.fill("offline-backup-password");
		const downloading = kind === "web" ? page.waitForEvent("download") : null;
		await page.locator("#backup-vault").click();
		await expect(
			page.locator("#vault-recovery-settings [role=status]"),
		).toBeVisible();
		const recovery =
			kind === "web"
				? await readFile(await (await downloading).path())
				: Buffer.from(await page.evaluate(() => window.lastDownload));
		expect(recovery.toString()).not.toContain("Team");
		expect(recovery.toString()).not.toContain(app.origin);
		await page.getByRole("button", { name: "Lock", exact: true }).click();
		await expect(other.locator("#master-password")).toBeVisible();
		await expect(other.locator("header")).toHaveCount(0);
		await expect(other.locator("#files")).not.toBeAttached();
		expect(
			(await other.evaluate(() => window.serviceTest("state"))).catalog,
		).toEqual([]);
		await page.locator("#master-password").fill("wrong-password");
		await page.locator("#unlock-vault").click();
		await expect(page.getByRole("alert")).toContainText("Wrong password");
		await shot(page, `vault-locked-error-${kind}-320`);
		await master(other);
		await expect(page.locator("#library-selector option")).toHaveCount(2);
		await page.locator("#master-password-settings > summary").click();
		await page.locator("#current-master").fill(PASSWORD);
		await page.locator("#new-master").fill("changed-master-password");
		await page.locator("#confirm-new-master").fill("changed-master-password");
		await page
			.getByRole("button", { name: "Change master password", exact: true })
			.click();
		await expect(
			page.locator("#master-password-settings [role=status]"),
		).toContainText("Master password changed");
		await page.getByRole("button", { name: "Lock", exact: true }).click();
		await page.locator("#master-password").fill(PASSWORD);
		await page.locator("#unlock-vault").click();
		await expect(page.getByRole("alert")).toContainText("Wrong password");
		await master(page, "changed-master-password");
		const context = await browser.newContext();
		await context.addInitScript(installBrowser);
		try {
			const recipient = await context.newPage();
			await recipient.goto(url(kind, app));
			await master(recipient, "different-master-password");
			await recipient
				.getByRole("tab", { name: "Restore", exact: true })
				.click();
			await recipient.locator("#file").setInputFiles({
				name: "vault.json",
				mimeType: "application/json",
				buffer: recovery,
			});
			await recipient.locator("#restore-pass").fill("offline-backup-password");
			await recipient.locator("#preview-recovery").click();
			await expect(recipient.locator("#restore-panel li")).toHaveCount(2);
			await recipient.locator("#restore").click();
			await expect(recipient.locator("#library-selector option")).toHaveCount(
				2,
			);
			await expect(recipient.locator("#library-selector option")).toHaveText([
				"Personal 1",
				"Team",
			]);
			await recipient
				.getByRole("button", { name: "Lock", exact: true })
				.click();
			await master(recipient, "different-master-password");
			await expect(recipient.locator("#library-selector option")).toHaveCount(
				2,
			);
		} finally {
			await context.close();
			await other.close();
		}
	});
}
