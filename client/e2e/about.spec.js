import metadata from "../package.json" with { type: "json" };
import { expect, master, shot, test } from "./fixtures.js";

const { repository, version } = metadata;

test("About shows client metadata and restores focus after dismissal", async ({
	page,
	app,
}) => {
	for (const [name, url] of [
		["web", app.origin],
		["extension", `${app.web.origin}/client/dist/extension/library.html`],
		["upload", `${app.web.origin}/client/dist/extension/upload.html`],
	]) {
		await page.goto(url);
		await master(page);
		const about = page.getByRole("button", { name: "About", exact: true });
		const dialog = page.getByRole("dialog", { name: "About i2nclip" });
		await about.click();
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText(`Version ${version}`);
		await expect(dialog).toContainText(
			"encrypted on your device before upload",
		);
		await expect(dialog).toContainText("cannot read your media or its details");
		const link = dialog.getByRole("link", { name: repository.url });
		await expect(link).toHaveAttribute("href", repository.url);
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", "noopener noreferrer");
		const currentUrl = page.url();
		for (const width of [1100, 360, 320]) {
			await page.setViewportSize({ width, height: 800 });
			await shot(page, `about-${name}-${width}`);
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= window.innerWidth,
				),
			).toBe(true);
		}
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(about).toBeFocused();
		await about.click();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await expect(about).toBeFocused();
		await about.click();
		await page.mouse.click(1, 1);
		await expect(dialog).toBeHidden();
		await expect(about).toBeFocused();
		expect(page.url()).toBe(currentUrl);
	}
});
