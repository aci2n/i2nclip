import type { Page } from "@playwright/test";
import { assertPresent } from "../tests/assert.ts";
import {
	audioFixture,
	createLibrary,
	expect,
	imageFixture,
	master,
	openUploadPreferences,
	shot,
	test,
} from "./fixtures.ts";

async function consistentControls(page: Page, touch: boolean) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	if (!touch) {
		return;
	}
	for (const control of await page.getByRole("button").all()) {
		if (await control.isVisible()) {
			expect(
				assertPresent(await control.boundingBox()).height,
			).toBeGreaterThanOrEqual(44);
		}
	}
	for (const control of await page
		.locator(
			'input:not([type="checkbox"]):not([type="hidden"]), select, summary',
		)
		.all()) {
		if (await control.isVisible()) {
			expect(
				assertPresent(await control.boundingBox()).height,
			).toBeGreaterThanOrEqual(44);
			if (
				await control.evaluate(
					(node: { tagName: string }) =>
						node.tagName === "INPUT" || node.tagName === "SELECT",
				)
			) {
				expect(
					await control.evaluate((node: Element) =>
						Number.parseFloat(getComputedStyle(node).fontSize),
					),
				).toBeGreaterThanOrEqual(16);
			}
		}
	}
}
test("setup and settings controls fit narrow screens", async ({
	page,
	app,
}) => {
	await page.goto(`${app.origin}/#/settings`);
	await master(page);
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		for (const mode of ["Create", "Restore", "Pair device"]) {
			await page.getByRole("button", { name: mode, exact: true }).click();
			await consistentControls(page, width < 500);
			await shot(page, `setup-${mode}-${width}`);
		}
	}
	await createLibrary(page, app);
	await expect(
		page.getByRole("region", { name: "Library usage", exact: true }),
	).toContainText("Retained files: 0");
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await consistentControls(page, width < 500);
		await shot(page, `settings-${width}`);
	}
});

test("mixed selected media and errors render in both themes at desktop and narrow widths", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await openUploadPreferences(page);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		await imageFixture(page, "Landscape.png", 960, 540),
		await imageFixture(page, "Portrait.png", 480, 800),
		await imageFixture(page, "Panorama.png", 1600, 240),
		audioFixture(),
		{
			name: "A very long ordinary filename with spaces and punctuation.pdf",
			mimeType: "application/pdf",
			buffer: Buffer.from("ordinary file bytes"),
		},
	]);
	await expect(page.getByRole("article")).toHaveCount(5);
	await page.route("**/api/blobs", (route) =>
		route.fulfill({ status: 503, body: "unavailable" }),
	);
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "failed.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("error"),
	});
	await expect(
		page.getByRole("region", { name: "Uploads", exact: true }),
	).toContainText("failed.txt");
	await page.unroute("**/api/blobs");
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await consistentControls(page, width < 500);
		await shot(page, `mixed-library-${width}`);
	}
	await page
		.getByRole("button", { name: "Open Panorama.png", exact: true })
		.click();
	for (const width of [1100, 320]) {
		await page.setViewportSize({ width, height: 800 });
		await shot(page, `panorama-preview-${width}`, { fullPage: false });
	}
});
