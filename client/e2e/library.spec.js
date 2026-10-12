import { createLibrary, expect, png, shot, test } from "./fixtures.js";

test("extension views share metadata, uploads and deletion while retaining searches", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const second = await page.context().newPage();
	await second.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await expect(second.locator("#files")).toBeAttached();
	await page
		.locator("#files")
		.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
	await expect(second.locator(".card-title")).toHaveText("photo.png");
	const card = page.locator(".card");
	await card.getByRole("button", { name: "Add tag to photo.png" }).click();
	await card.locator(".tags input").fill("One");
	await card.locator(".tags input").press("Enter");
	await expect(second.locator(".tag-text")).toHaveText(["One"]);
	await second.locator("#tags").fill("missing");
	await second.locator("#tags").press("Enter");
	await expect(second.locator("#empty-library")).toContainText(
		"No files match",
	);
	await expect(card).toHaveCount(1);
	await page.bringToFront();
	page.once("dialog", (dialog) => dialog.accept());
	await card.locator('[data-act="delete"]').click();
	await expect(card).toHaveClass(/deleted/);
	await expect(card.locator('[data-act="delete"]')).toBeDisabled();
	await page.locator("#tags").press("Enter");
	await expect(card).toHaveCount(0);
	await expect(page.locator("#empty-library")).toContainText(
		"Your library is empty",
	);
	await second.close();
});

test("realistic mixed media and long tags remain usable at narrow widths in both themes", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.evaluate(async () => {
		const sources = [];
		for (const [width, height, name] of [
			[960, 540, "Landscape.png"],
			[540, 960, "Portrait with a very long descriptive filename.png"],
			[1600, 360, "Panorama.png"],
		]) {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			context.fillStyle = "#328878";
			context.fillRect(0, 0, width, height);
			context.fillStyle = "#dcebbd";
			context.beginPath();
			context.arc(
				width / 2,
				height / 2,
				Math.min(width, height) / 3,
				0,
				2 * Math.PI,
			);
			context.fill();
			const blob = await new Promise((resolve) =>
				canvas.toBlob(resolve, "image/png"),
			);
			sources.push({ blob, name });
		}
		sources.push({
			blob: new Blob(["ordinary file"], { type: "text/plain" }),
			name: "A file with a long name.txt",
		});
		// A valid short WAV containing silence.
		const wav = new ArrayBuffer(44 + 800);
		const view = new DataView(wav);
		const ascii = (offset, text) =>
			[...text].forEach((char, index) => {
				view.setUint8(offset + index, char.charCodeAt(0));
			});
		ascii(0, "RIFF");
		view.setUint32(4, 836, true);
		ascii(8, "WAVEfmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 8000, true);
		view.setUint32(28, 16000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		ascii(36, "data");
		view.setUint32(40, 800, true);
		sources.push({
			blob: new Blob([wav], { type: "audio/wav" }),
			name: "Audio.wav",
		});
		await window.serviceTest("uploads.submit", { sources });
	});
	await page.locator("#files").setInputFiles("e2e/fixtures/clip.webm");
	await expect(page.locator(".card")).toHaveCount(6);
	const portrait = page.locator(".card").filter({ hasText: "Portrait with" });
	await portrait.getByRole("button", { name: /Add tag/ }).click();
	await portrait
		.locator(".tags input")
		.fill("A very long tag with readable spacing");
	await portrait.locator(".tags input").press("Enter");
	await expect(portrait.locator(".tag-text")).toHaveText([
		"A very long tag with readable spacing",
	]);
	for (const width of [1100, 360, 320]) {
		await page.setViewportSize({ width, height: 800 });
		await shot(page, `service-library-${width}`);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	}
});

test("a failed remote capture remains available for explicit discard", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	// A remote source failure is retained independently of the source page's UI.
	await page.evaluate(() =>
		window.serviceTest("context", {
			source: { id: "failed", srcUrl: `${location.origin}/missing-source.txt` },
			withTags: true,
		}),
	);
	await expect(
		page.getByRole("region", { name: "Failed uploads" }),
	).toContainText("Could not fetch");
	await page.getByRole("button", { name: "Discard retained files" }).click();
	await expect(
		page.getByRole("region", { name: "Failed uploads" }),
	).toBeHidden();
});
