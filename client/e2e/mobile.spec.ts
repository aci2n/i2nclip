import { readFile } from "node:fs/promises";
import type { Locator } from "@playwright/test";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { assertPresent } from "../tests/assert.ts";
import {
	audioFixture,
	createLibrary,
	expect,
	imageFixture,
	shot,
	test,
} from "./fixtures.ts";

test("mobile tags wrap with usable touch controls and retain failed drafts", async ({
	page,
	app,
}) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "Notes with a long descriptive filename.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("A readable note on a narrow screen."),
	});
	const card = page.getByRole("article");
	await expect(card).toBeVisible();
	await card
		.getByRole("button", { name: "Show all tags", exact: true })
		.click();
	await page.getByRole("button", { name: "Dismiss completed uploads" }).click();
	const add = card.getByRole("button", { name: /^Add tag to / });
	const touch = async (locator: Locator) => {
		const box = await locator.boundingBox();
		expect(assertPresent(box).width).toBeGreaterThanOrEqual(44);
		expect(assertPresent(box).height).toBeGreaterThanOrEqual(44);
	};
	const tagTouch = async (locator: Locator) => {
		await touch(locator);
		const box = await locator.boundingBox();
		const icon = await locator.locator("svg").boundingBox();
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
	};
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await tagTouch(add);
		await shot(page, `tag-add-${width}`);
	}
	await add.click();
	const input = card.getByRole("textbox", { name: /^New tag for / });
	const tag = "AnUnbrokenTagThatNeedsToWrapAcrossNarrowCards";
	await input.fill(tag);
	await card.getByRole("button", { name: "Save tag", exact: true }).click();
	await expect(input).toBeFocused();
	await expect(input).toHaveValue("");
	await tagTouch(
		card.getByRole("button", { name: `Remove tag ${tag}`, exact: true }),
	);
	await input.fill("Remember");
	await input.press("Enter");
	await input.fill("remember");
	await input.press("Enter");
	await expect(card.locator(".tag-text")).toHaveText([
		"text",
		"txt",
		"notes",
		"with",
		"a",
		"long",
		"descriptive",
		"filename",
		tag,
		"Remember",
	]);
	await page.route("**/api/media/*/meta", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/msgpack",
			body: Buffer.from(encode({ error: "Tag update unavailable" })),
		}),
	);
	await input.fill("Keep my draft");
	await input.press("Enter");
	await expect(
		card.getByText("Tag update unavailable", { exact: true }),
	).toBeVisible();
	await expect(input).toHaveValue("Keep my draft");
	await expect(input).toBeFocused();
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await tagTouch(card.getByRole("button", { name: "Save tag", exact: true }));
		await tagTouch(
			card.getByRole("button", { name: "Cancel adding tag", exact: true }),
		);
		await tagTouch(
			card.getByRole("button", { name: `Remove tag ${tag}`, exact: true }),
		);
		expect(assertPresent(await input.boundingBox()).width).toBeGreaterThan(100);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await shot(page, `tag-editor-${width}`);
	}
	await page.unroute("**/api/media/*/meta");
	await input.press("Escape");
	await expect(add).toBeFocused();
	await card
		.getByRole("button", { name: `Remove tag ${tag}`, exact: true })
		.click();
	await expect(card.locator(".tag-text")).toHaveText([
		"text",
		"txt",
		"notes",
		"with",
		"a",
		"long",
		"descriptive",
		"filename",
		"Remember",
	]);
	await card.getByRole("button", { name: /^Open Notes/ }).click();
	await expect(page.locator("dialog pre")).toHaveText(
		"A readable note on a narrow screen.",
	);
	const panel = await page.locator(".text-preview").boundingBox();
	for (const label of ["Previous media", "Next media"]) {
		const button = page.getByRole("button", { name: label, exact: true });
		await touch(button);
		expect(assertPresent(await button.boundingBox()).y).toBeGreaterThanOrEqual(
			assertPresent(panel).y + assertPresent(panel).height,
		);
	}
	await shot(page, "mobile-text-controls");
});
test("touch gestures browse loaded previews and close media without hijacking other interactions", async ({
	page,
	app,
	context,
	browserName,
}) => {
	await page.setViewportSize({ width: 360, height: 800 });
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		await imageFixture(page, "Landscape.png", 960, 540),
		await imageFixture(page, "Portrait.png", 360, 640),
		audioFixture(),
		{
			name: "Video.webm",
			mimeType: "video/webm",
			buffer: await readFile(new URL("./fixtures/clip.webm", import.meta.url)),
		},
		{
			name: "Notes.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("A scrolling note.\n".repeat(200)),
		},
	]);
	await expect(page.getByRole("article")).toHaveCount(5);
	const openers = page
		.getByRole("article")
		.getByRole("button", { name: /^(Open|Play) / });
	const firstName = assertPresent(
		await openers.first().getAttribute("aria-label"),
	).replace(/^(Open|Play) /, "");
	const secondName = assertPresent(
		await openers.nth(1).getAttribute("aria-label"),
	).replace(/^(Open|Play) /, "");
	await openers.first().click();
	const dialog = page.getByRole("dialog", { name: "Media preview" });
	const visibleName = async (name: string) => {
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("status")).toHaveCount(0);
		await expect(
			dialog
				.locator(
					`img[alt="${name}"], video[aria-label="${name}"], audio[aria-label="${name}"], section[aria-label="${name}"]`,
				)
				.first(),
		).toBeVisible();
	};
	const surface = () =>
		dialog.locator(".text-preview, .audio, video, img").first();
	const gesture = async (
		target: Locator,
		dx: number,
		dy: number,
		{ cancel = false, multitouch = false, pointerType = "touch" } = {},
	) => {
		const box = await target.boundingBox();
		const init = {
			pointerType,
			pointerId: 1,
			isPrimary: true,
			clientX: assertPresent(box).x + assertPresent(box).width / 2,
			clientY:
				assertPresent(box).y + Math.min(assertPresent(box).height / 2, 20),
			bubbles: true,
		};
		await target.dispatchEvent("pointerdown", init);
		if (multitouch) {
			await target.dispatchEvent("pointerdown", {
				...init,
				pointerId: 2,
				isPrimary: false,
			});
		}
		if (cancel) {
			await target.dispatchEvent("pointercancel", init);
		}
		await target.dispatchEvent("pointerup", {
			...init,
			clientX: init.clientX + dx,
			clientY: init.clientY + dy,
		});
	};
	await visibleName(firstName);
	await gesture(surface(), 100, 0);
	await visibleName(firstName);
	for (const [dx, dy, options] of [
		[20, 0, {}],
		[-100, -100, {}],
		[-100, 0, { cancel: true }],
		[-100, 0, { multitouch: true }],
		[-100, 0, { pointerType: "mouse" }],
	] as const) {
		await gesture(surface(), dx, dy, options);
		await visibleName(firstName);
	}
	await gesture(surface(), -100, 0);
	await visibleName(secondName);
	await gesture(surface(), 100, 0);
	await visibleName(firstName);
	await gesture(
		dialog.getByRole("button", { name: "Close preview", exact: true }),
		0,
		-100,
	);
	await expect(dialog).toBeVisible();
	await dialog
		.getByRole("button", { name: "Close preview", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Play Video.webm", exact: true })
		.click();
	await visibleName("Video.webm");
	const video = dialog.locator("video");
	const box = await video.boundingBox();
	await video.dispatchEvent("pointerdown", {
		pointerType: "touch",
		pointerId: 1,
		isPrimary: true,
		clientX: assertPresent(box).x + 20,
		clientY: assertPresent(box).y + assertPresent(box).height - 10,
	});
	await video.dispatchEvent("pointerup", {
		pointerType: "touch",
		pointerId: 1,
		isPrimary: true,
		clientX: assertPresent(box).x + 20,
		clientY: assertPresent(box).y + assertPresent(box).height - 110,
	});
	await expect(dialog).toBeVisible();
	await gesture(video, 0, -100);
	await expect(dialog).not.toBeVisible();
	await expect(
		page.getByRole("button", { name: "Play Video.webm", exact: true }),
	).toBeFocused();
	await page
		.getByRole("button", { name: "Open Notes.txt", exact: true })
		.click();
	await visibleName("Notes.txt");
	await gesture(surface(), 0, -100);
	await expect(dialog).toBeVisible();
	expect(
		await dialog.evaluate((node) => getComputedStyle(node).touchAction),
	).toContain("pan-y");
	const text = dialog.locator(".text-preview");
	await text.hover();
	await page.mouse.wheel(0, 200);
	await expect
		.poll(() => text.evaluate((node) => node.scrollTop))
		.toBeGreaterThan(0);
	if (browserName === "chromium") {
		// Chromium exposes native touch injection; Firefox uses the pointer sequences above.
		await dialog
			.getByRole("button", { name: "Close preview", exact: true })
			.click();
		const imageButton = page.getByRole("button", { name: /^Open Landscape\./ });
		const imageName = assertPresent(
			await imageButton.getAttribute("aria-label"),
		).slice(5);
		await imageButton.click();
		await visibleName(imageName);
		const bounds = await dialog.locator("img").boundingBox();
		const left = await dialog
			.getByRole("button", { name: "Next media", exact: true })
			.isEnabled();
		const x = assertPresent(bounds).x + assertPresent(bounds).width / 2;
		const y = assertPresent(bounds).y + assertPresent(bounds).height / 2;
		const native = await context.newCDPSession(page);
		try {
			await native.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ x, y }],
			});
			await native.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: x + (left ? -100 : 100), y }],
			});
			await native.send("Input.dispatchTouchEvent", {
				type: "touchEnd",
				touchPoints: [],
			});
			await expect(dialog.locator(`img[alt="${imageName}"]`)).toHaveCount(0);
			await expect(dialog).toBeVisible();
		} finally {
			await native.detach();
		}
	}
});
