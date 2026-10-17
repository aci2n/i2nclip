import type { Page } from "@playwright/test";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { assertPresent } from "../tests/assert.ts";
import {
	audioFixture,
	createLibrary,
	expect,
	imageFixture,
	issueOtc,
	master,
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
test("setup, settings and independently locked tabs share usable controls at every width", async ({
	page,
	app,
}) => {
	await page.goto(`${app.origin}/?page=settings`);
	await master(page);
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		for (const mode of ["Create", "Restore", "Pair device"]) {
			await page.getByRole("button", { name: mode, exact: true }).click();
			await consistentControls(page, width < 500);
			await shot(
				page,
				`setup-${mode.toLowerCase().replaceAll(" ", "-")}-${width}`,
			);
		}
	}
	await page.getByRole("button", { name: "Create", exact: true }).click();
	await page
		.getByLabel("Invitation code", { exact: true })
		.fill(await issueOtc(app.data));
	await page
		.getByRole("button", { name: "Create library", exact: true })
		.click();
	await expect(
		page.getByRole("region", { name: "Library usage", exact: true }),
	).toContainText("Files: 0");
	for (const summary of await page.locator("details.panel > summary").all()) {
		await summary.click();
	}
	await page
		.getByLabel("Current master password", { exact: true })
		.fill("incorrect");
	await page
		.getByLabel("New master password", { exact: true })
		.fill("another-password");
	await page
		.getByLabel("Confirm new master password", { exact: true })
		.fill("another-password");
	await page
		.getByRole("button", { name: "Change password", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("Wrong password");
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await consistentControls(page, width < 500);
		if (width < 500) {
			expect(
				assertPresent(
					await page
						.getByRole("checkbox", { name: "Compress images to WebP" })
						.locator("..")
						.boundingBox(),
				).height,
			).toBeGreaterThanOrEqual(44);
		}
		await shot(page, `settings-controls-${width}`);
		await page.getByRole("button", { name: "About", exact: true }).click();
		const dialog = page.getByRole("dialog", {
			name: "About i2nclip",
			exact: true,
		});
		await expect(dialog).toBeVisible();
		await consistentControls(page, width < 500);
		await shot(page, `about-controls-${width}`, { fullPage: false });
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
	}
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeVisible();
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await consistentControls(page, width < 500);
		await shot(page, `unlock-controls-${width}`);
	}
	const other = await page.context().newPage();
	try {
		await other.goto(app.origin);
		await expect(
			other.getByRole("button", { name: "Unlock", exact: true }),
		).toBeVisible();
		for (const width of [1100, 320, 360]) {
			await other.setViewportSize({ width, height: 800 });
			await consistentControls(other, width < 500);
			const panel = await other.locator("main > section").boundingBox();
			expect(assertPresent(panel).x).toBeGreaterThanOrEqual(15);
			expect(
				assertPresent(panel).x + assertPresent(panel).width,
			).toBeLessThanOrEqual(width - 15);
			await shot(other, `other-tab-unlock-controls-${width}`);
		}
	} finally {
		await other.close();
	}
});
test("mixed media, inline filename editing and preview icons stay consistent across themes and widths", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.route("**/api/tags", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/msgpack",
			body: Buffer.from(encode({ error: "Tag suggestions unavailable" })),
		}),
	);
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		await imageFixture(page, "Landscape shot.png", 960, 540),
		await imageFixture(page, "Portrait.png", 480, 800),
		await imageFixture(page, "Panorama.png", 1600, 240),
		audioFixture(),
		{
			name: "Readable notes with a long descriptive filename.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Readable notes\nAnother line."),
		},
		{
			name: "A very long document filename that should wrap cleanly.pdf",
			mimeType: "application/pdf",
			buffer: Buffer.from("An ordinary document"),
		},
	]);
	await expect(page.getByRole("article")).toHaveCount(6);
	await expect(page.getByRole("alert")).toContainText(
		"Tag suggestions unavailable",
	);
	const dialog = page.getByRole("dialog", {
		name: "Media preview",
		exact: true,
	});
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await consistentControls(page, width < 500);
		await page
			.getByRole("button", {
				name: "Edit filename Landscape shot.png",
				exact: true,
			})
			.click();
		const filename = page.getByRole("textbox", {
			name: "Filename for Landscape shot.png",
			exact: true,
		});
		await expect(filename).toBeFocused();
		await consistentControls(page, width < 500);
		await shot(page, `gallery-filename-${width}`);
		await filename.press("Escape");
		for (const name of [
			"Open Portrait.png",
			"Play Voice memo.wav",
			"Open Readable notes with a long descriptive filename.txt",
		]) {
			await page.getByRole("button", { name, exact: true }).click();
			await expect(dialog).toBeVisible();
			if (name.startsWith("Play")) {
				await expect(dialog.locator("audio")).toHaveAttribute("src", /^blob:/);
			} else if (name.includes("notes")) {
				await expect(dialog.locator("pre")).toContainText("Readable notes");
			} else {
				await expect(dialog.getByRole("img")).toBeVisible();
			}
			for (const control of await dialog.getByRole("button").all()) {
				const box = await control.boundingBox();
				expect(assertPresent(box).width).toBeGreaterThanOrEqual(44);
				expect(
					Math.abs(assertPresent(box).width - assertPresent(box).height),
				).toBeLessThanOrEqual(1);
				const icon = await control.locator("svg").boundingBox();
				expect(
					Math.abs(
						assertPresent(icon).x +
							assertPresent(icon).width / 2 -
							(assertPresent(box).x + assertPresent(box).width / 2),
					),
				).toBeLessThanOrEqual(1);
				expect(
					Math.abs(
						assertPresent(icon).y +
							assertPresent(icon).height / 2 -
							(assertPresent(box).y + assertPresent(box).height / 2),
					),
				).toBeLessThanOrEqual(1);
			}
			await shot(
				page,
				`preview-${name.includes("notes") ? "text" : name.startsWith("Play") ? "audio" : "image"}-${width}`,
				{ fullPage: false },
			);
			await dialog
				.getByRole("button", { name: "Close preview", exact: true })
				.click();
		}
	}
	await page.unroute("**/api/tags");
	await page
		.getByRole("button", { name: "Retry tag suggestions", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveCount(0);
});
