import { readFile } from "node:fs/promises";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { assertPresent } from "../tests/assert.ts";
import {
	audioFixture,
	createLibrary,
	expect,
	imageFixture,
	master,
	PASSWORD,
	recovery,
	restore,
	shot,
	test,
} from "./fixtures.ts";

test("web library uploads, edits tags, searches, verifies downloads, and deletes", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
	await expect(page.getByLabel("Library name", { exact: true })).toHaveCount(0);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Your library is empty" }),
	).toBeVisible();
	const image = await imageFixture(page, "Landscape.png", 960, 540);
	await page.getByLabel("Upload", { exact: true }).setInputFiles(image);
	const card = page.getByRole("article");
	await expect(card).toHaveCount(1);
	await expect(
		card.getByText("Landscape.png", { exact: true }).first(),
	).toBeVisible();
	await card.getByRole("button", { name: "Add tag to Landscape.png" }).click();
	const draft = card.getByRole("textbox", {
		name: "New tag for Landscape.png",
	});
	await draft.fill("Vacation");
	await draft.press("Enter");
	await expect(card.locator(".tag-text")).toHaveText([
		"image",
		"png",
		"landscape",
		"Vacation",
	]);
	await expect(draft).toHaveValue("");
	await expect(draft).toBeFocused();
	await page.route("**/api/media/*/meta", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/msgpack",
			body: Buffer.from(encode({ error: "Tag edits unavailable" })),
		}),
	);
	await draft.fill("Remember");
	await draft.press("Enter");
	await expect(
		card.getByText("Tag edits unavailable", { exact: true }),
	).toBeVisible();
	await expect(draft).toHaveValue("Remember");
	await expect(draft).toBeFocused();
	await page.unroute("**/api/media/*/meta");
	await draft.press("Enter");
	await expect(card.locator(".tag-text")).toHaveText([
		"image",
		"png",
		"landscape",
		"Vacation",
		"Remember",
	]);
	await expect(draft).toHaveValue("");
	await card
		.getByRole("button", { name: "Remove tag Remember", exact: true })
		.click();
	await expect(card.locator(".tag-text")).toHaveText([
		"image",
		"png",
		"landscape",
		"Vacation",
	]);
	await expect(
		card.getByRole("button", { name: "Remove tag Vacation", exact: true }),
	).toBeEnabled();
	await draft.fill("vacation");
	await draft.press("Enter");
	await expect(card.locator(".tag-text")).toHaveText([
		"image",
		"png",
		"landscape",
		"Vacation",
	]);
	await expect(draft).toHaveValue("");
	await draft.press("Escape");
	await expect(
		card.getByRole("button", { name: "Add tag to Landscape.png" }),
	).toBeFocused();
	const search = page.getByRole("searchbox");
	await search.fill("missing");
	await search.press("Enter");
	await expect(
		page.getByRole("heading", { name: "No files match your search" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(card).toHaveCount(1);
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	expect(await readFile(await (await downloading).path())).toEqual(
		image.buffer,
	);
	await card.getByRole("button", { name: "Open Landscape.png" }).click();
	await expect(
		page.getByRole("dialog", { name: "Media preview" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Close preview" }).click();
	page.once("dialog", (dialog) => dialog.accept());
	await card.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(card).toHaveCount(1);
	await expect(card).toHaveClass(/deleted/);
	await expect(card).toHaveCSS("opacity", "0.2");
	for (const button of await card.getByRole("button").all()) {
		await expect(button).toBeDisabled();
	}
	await shot(page, "deleted-card-desktop");
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize({ width: 320, height: 800 });
	await shot(page, "deleted-card-dark-narrow");
	await page.reload();
	await master(page);
	await expect(card).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Your library is empty" }),
	).toBeVisible();
	expect(await page.locator("[id]").count()).toBe(0);
});
test("encrypted singleton recovery, password change, reload, and forget", async ({
	page,
	app,
	browser,
}) => {
	await createLibrary(page, app);
	const bytes = await recovery(page);
	const saved = await page.evaluate(() =>
		localStorage.getItem("i2nclip.identity"),
	);
	expect(saved).not.toContain("privateKey");
	expect(saved).not.toContain(PASSWORD);
	const context = await browser.newContext();
	try {
		const other = await context.newPage();
		await restore(other, app, bytes);
		await other.getByText("Change master password", { exact: true }).click();
		await other
			.getByLabel("Current master password", { exact: true })
			.fill(PASSWORD);
		await other
			.getByLabel("New master password", { exact: true })
			.fill("changed-pass");
		await other
			.getByLabel("Confirm new master password", { exact: true })
			.fill("changed-pass");
		await other
			.getByRole("button", { name: "Change password", exact: true })
			.click();
		await expect(
			other.getByRole("status").filter({ hasText: "Master password changed." }),
		).toHaveText("Master password changed.");
		await other.reload();
		await other.getByLabel("Master password", { exact: true }).fill(PASSWORD);
		await other.getByRole("button", { name: "Unlock", exact: true }).click();
		await expect(other.getByRole("alert")).toContainText("Wrong password");
		await other
			.getByLabel("Master password", { exact: true })
			.fill("changed-pass");
		await other.getByRole("button", { name: "Unlock", exact: true }).click();
		await expect(
			other.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		await other.getByText("Forget this library", { exact: true }).click();
		other.once("dialog", (dialog) => dialog.accept());
		await other
			.getByRole("button", { name: "Forget library", exact: true })
			.click();
		await expect(
			other.getByRole("button", { name: "Create library", exact: true }),
		).toBeVisible();
	} finally {
		await context.close();
	}
});
test("tabs inherit access, reconnect after password changes, and forget together", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const second = await page.context().newPage();
	try {
		await second.goto(`${app.origin}/?page=settings`);
		await expect(
			second.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		await expect(
			second.getByRole("button", { name: "Unlock", exact: true }),
		).toHaveCount(0);
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
		await expect(
			second.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		// The inherited wrapping key must support identity mutations after donor closure.
		await page.goto("about:blank");
		await second.getByText("Forget this library", { exact: true }).click();
		second.once("dialog", (dialog) => dialog.accept());
		await second
			.getByRole("button", { name: "Forget library", exact: true })
			.click();
		await expect(
			second.getByRole("button", { name: "Create library", exact: true }),
		).toBeVisible();
		await page.goto(`${app.origin}/?page=settings`);
		await expect(
			page.getByRole("button", { name: "Create library", exact: true }),
		).toBeVisible();
		await second.close();
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Unlock", exact: true }),
		).toBeVisible();
		await page
			.getByLabel("Master password", { exact: true })
			.fill("changed-password");
		await page.getByRole("button", { name: "Unlock", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Create library", exact: true }),
		).toBeVisible();
	} finally {
		if (!second.isClosed()) {
			await second.close();
		}
	}
});
test("upload failures survive navigation and files can be selected again", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	let posts = 0;
	let fail = true;
	let releaseSecond: (() => void) | undefined;
	const holding = new Promise<void>((resolve) => {
		releaseSecond = resolve;
	});
	await page.route("**/api/media", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		posts++;
		if (fail && posts === 1) {
			await route.fulfill({
				status: 503,
				contentType: "application/msgpack",
				body: Buffer.from(encode({ error: "Upload unavailable" })),
			});
		} else {
			if (posts === 2) {
				await holding;
			}
			await route.continue();
		}
	});
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		{
			name: "failed.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("retry me"),
		},
		{
			name: "saved.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("save me"),
		},
	]);
	try {
		await expect.poll(() => posts).toBe(2);
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
	} finally {
		assertPresent(releaseSecond)();
	}
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(
		page.getByText("failed.txt: Upload unavailable", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(1);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	fail = false;
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "failed.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("retry me"),
	});
	await expect(page.getByRole("article")).toHaveCount(2);
	await expect(
		page.getByText("failed.txt: Upload unavailable", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Retry failed files", exact: true }),
	).toHaveCount(0);
	expect(posts).toBe(3);
});
test("mixed media and feedback render in both themes at desktop and narrow widths", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const longName =
		"Portrait with a very long descriptive filename for narrow library cards.png";
	const video = {
		name: "Video.webm",
		mimeType: "video/webm",
		buffer: await readFile(new URL("./fixtures/clip.webm", import.meta.url)),
	};
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		await imageFixture(page, "Landscape.png", 960, 540),
		await imageFixture(page, longName, 360, 640),
		await imageFixture(page, "Panorama.png", 1600, 240),
		audioFixture(),
		video,
		{
			name: "Notes.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Ordinary document"),
		},
	]);
	await expect(page.getByRole("article")).toHaveCount(6);
	await page.getByRole("button", { name: "Dismiss completed uploads" }).click();
	await page.getByRole("button", { name: "Play Voice memo.wav" }).click();
	await expect(page.locator("audio")).toBeVisible();
	await page.getByRole("button", { name: "Close preview" }).click();
	await page.getByRole("button", { name: "Play Video.webm" }).click();
	await expect(page.locator("video")).toBeVisible();
	await page.getByRole("button", { name: "Close preview" }).click();
	for (const width of [1100, 360, 320]) {
		await page.setViewportSize({ width, height: 800 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		for (const image of await page.locator(".preview-button img").all()) {
			const bounds = await image.evaluate((node) => {
				function assertPresent<T>(value: T | null | undefined): T {
					if (value === null || value === undefined) {
						throw new Error("Required test value is missing.");
					}
					return value;
				}
				const image = node.getBoundingClientRect();
				const button = assertPresent(
					node.parentElement,
				).getBoundingClientRect();
				return {
					image: { width: image.width, height: image.height },
					button: { width: button.width, height: button.height },
				};
			});
			expect(bounds.image.width).toBeLessThanOrEqual(bounds.button.width + 1);
			expect(bounds.image.height).toBeLessThanOrEqual(bounds.button.height + 1);
		}
		await shot(page, `${test.info().project.name}-library-${width}`);
	}
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "Library usage", exact: true }),
	).toContainText("Files: 6");
	await page.getByText("Change master password", { exact: true }).click();
	await page
		.getByLabel("Current master password", { exact: true })
		.fill("incorrect");
	await page
		.getByLabel("New master password", { exact: true })
		.fill("new-password");
	await page
		.getByLabel("Confirm new master password", { exact: true })
		.fill("new-password");
	await page
		.getByRole("button", { name: "Change password", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("Wrong password");
	await shot(page, `${test.info().project.name}-settings-error-320`);
});
test("pairing transfers the single identity only after explicit verification", async ({
	page,
	app,
	browser,
}) => {
	await createLibrary(page, app);
	await page.getByText("Connect another device", { exact: true }).click();
	await page
		.getByRole("button", { name: "Create pairing code", exact: true })
		.click();
	const code = page.getByLabel("Pairing code", { exact: true });
	await expect(code).toBeVisible();
	const context = await browser.newContext();
	try {
		const receiver = await context.newPage();
		await receiver.goto(`${app.origin}/?page=settings`);
		await master(receiver);
		await receiver
			.getByRole("button", { name: "Pair device", exact: true })
			.click();
		await receiver
			.getByLabel("Pairing code", { exact: true })
			.fill(assertPresent(await code.textContent()));
		await receiver
			.getByRole("button", { name: "Connect library", exact: true })
			.click();
		await expect(
			page.getByRole("button", {
				name: "Codes match — send library",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			receiver.getByLabel("Verification code", { exact: true }),
		).toBeVisible();
		expect(
			await receiver
				.getByLabel("Verification code", { exact: true })
				.textContent(),
		).toBe(
			await page.getByLabel("Verification code", { exact: true }).textContent(),
		);
		await expect(
			receiver.getByRole("heading", { name: "Your library", exact: true }),
		).toHaveCount(0);
		await page
			.getByRole("button", { name: "Codes match — send library", exact: true })
			.click();
		await expect(
			receiver.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("status")).toHaveText("New device connected.");
		await receiver.reload();
		await master(receiver);
		await expect(
			receiver.getByRole("heading", { name: "Your library", exact: true }),
		).toBeVisible();
	} finally {
		await context.close();
	}
});
