import { readFile } from "node:fs/promises";
import { handoff } from "../extension/bridge.js";
import {
	createLibrary,
	expect,
	imageFixture,
	master,
	shot,
	test,
} from "./fixtures.js";

test("extension bridge hands a file to the real web upload flow", async ({
	page,
	app,
	context,
}) => {
	await createLibrary(page, app);
	const image = await imageFixture(
		page,
		`${"Long portrait filename ".repeat(7)}.png`,
		640,
		960,
	);
	const request = {
		type: "file",
		name: image.name,
		mime: image.mimeType,
		base64: image.buffer.toString("base64"),
	};
	await page.getByRole("button", { name: "Lock", exact: true }).click();
	const deliver = () =>
		page.evaluate(handoff, { appUrl: `${app.origin}/`, request });
	expect(await deliver()).toEqual({ ok: true, needsUnlock: true });
	await expect(page.getByText(image.name, { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Upload file" })).toHaveCount(
		0,
	);
	expect((await deliver()).ok).toBe(false);
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 780 });
		await shot(page, `extension-locked-${width}`);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	}
	await page
		.getByLabel("Master password", { exact: true })
		.fill("wrong-password");
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("navigation", { name: "Main navigation" }),
	).toHaveCount(0);
	await expect(page.getByText(image.name, { exact: true })).toHaveCount(0);
	await master(page);
	const card = page.getByRole("article");
	await expect(card).toHaveCount(1);
	await expect(
		card.getByText(image.name, { exact: true }).first(),
	).toBeVisible();
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	expect(await readFile(await (await downloading).path())).toEqual(
		image.buffer,
	);

	// An unlocked app immediately uploads and returns to Library from Settings.
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	expect(
		await page.evaluate(handoff, {
			appUrl: `${app.origin}/`,
			request: { ...request, name: "Second portrait.png" },
		}),
	).toEqual({ ok: true, needsUnlock: false });
	await expect(page.getByRole("searchbox")).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(2);

	await page.getByRole("button", { name: "Lock", exact: true }).click();
	expect(await deliver()).toEqual({ ok: true, needsUnlock: true });
	// Reload discards a hidden capture rather than uploading it after unlock.
	await page.reload();
	await master(page);
	await expect(page.getByRole("article")).toHaveCount(2);

	// The rejected second tab has no receiver and cannot accept a file.
	const other = await context.newPage();
	try {
		await other.goto(app.origin);
		await expect(other.getByText(/already open in another tab/)).toBeVisible();
		expect(
			await other.evaluate(handoff, {
				appUrl: `${app.origin}/`,
				request: { type: "probe" },
				timeout: 50,
			}),
		).toMatchObject({ ok: false, unavailable: true });
	} finally {
		await other.close();
	}

	expect(
		await page.evaluate(handoff, { appUrl: "https://other.example/", request }),
	).toMatchObject({ ok: false });
});
