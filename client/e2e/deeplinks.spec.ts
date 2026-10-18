import { readFile } from "node:fs/promises";
import type { Page, Request } from "@playwright/test";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { assertPresent } from "../tests/assert.ts";
import { deferred } from "../tests/helpers.ts";
import {
	audioFixture,
	createLibrary,
	expect,
	imageFixture,
	PASSWORD,
	recovery,
	shot,
	test,
} from "./fixtures.ts";

async function linkFor(page: Page, name: string) {
	const card = page.getByRole("article").filter({ hasText: name });
	const link = card.getByRole("link", { name: `Link to ${name}`, exact: true });
	const href = assertPresent(await link.getAttribute("href"));
	expect(href).toMatch(/^\?page=media&id=[0-9a-f]{64}$/);
	return { link, href };
}

test("private links inherit access and show native media, escaped text and explicit file downloads without browsing queries", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
	const files = [
		await imageFixture(page, "Landscape.png", 960, 540),
		await imageFixture(page, "Portrait.png", 480, 800),
		await imageFixture(page, "Panorama.png", 1600, 240),
		audioFixture(),
		{
			name: "Clip.webm",
			mimeType: "video/webm",
			buffer: await readFile(new URL("./fixtures/clip.webm", import.meta.url)),
		},
		{
			name: "note.html",
			mimeType: "text/html",
			buffer: Buffer.from(
				"<script>window.deeplinkExecuted=true</script>\nhello",
			),
		},
		{
			name: `${"Long document filename ".repeat(5)}.pdf`,
			mimeType: "application/pdf",
			buffer: Buffer.from("ordinary file bytes"),
		},
	];
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(files);
	await expect(page.getByRole("article")).toHaveCount(files.length);
	const first = await linkFor(page, files[0].name);
	const card = page.getByRole("article").filter({ hasText: files[0].name });
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			const appearance = (element: HTMLElement | SVGElement) => {
				const style = getComputedStyle(element);
				return [
					style.backgroundColor,
					style.color,
					style.border,
					style.borderRadius,
					style.font,
					style.padding,
					style.minHeight,
					style.height,
				];
			};
			await expect(first.link).toHaveText("Link");
			expect(await first.link.evaluate(appearance)).toEqual(
				await card
					.getByRole("button", { name: "Download", exact: true })
					.evaluate(appearance),
			);
			await page.screenshot({
				path: test.info().outputPath(`link-${width}-${colorScheme}.png`),
				fullPage: true,
			});
		}
	}
	await page.setViewportSize({ width: 1100, height: 800 });
	const unwanted: string[] = [];
	const errors: string[] = [];
	const request = (request: Request) => {
		const path = new URL(request.url()).pathname;
		if (
			["/api/media", "/api/tags"].includes(path) &&
			request.frame().page() !== page
		) {
			unwanted.push(path);
		}
	};
	const watch = (tab: Page) =>
		tab.on("pageerror", (error) => errors.push(error.message));
	page.context().on("request", request);
	page.context().on("page", watch);
	try {
		for (const [index, file] of files.entries()) {
			const { link, href } = await linkFor(page, file.name);
			const opened = page.waitForEvent("popup");
			await link.click();
			const viewer = await opened;
			try {
				await expect(
					viewer.getByRole("region", { name: "File viewer" }),
				).toBeVisible();
				await expect(
					viewer.getByRole("heading", { name: file.name, exact: true }),
				).toBeVisible();
				const download = viewer.getByRole("button", {
					name: "Download",
					exact: true,
				});
				await expect(download).toBeEnabled();
				expect(new URL(viewer.url()).search).toBe(href);
				await expect(
					viewer.getByRole("button", { name: "Unlock", exact: true }),
				).toHaveCount(0);
				if (file.mimeType.startsWith("image/")) {
					await expect(
						viewer.getByRole("img", { name: file.name, exact: true }),
					).toBeVisible();
					expect(
						await viewer
							.locator("img")
							.evaluate((image: HTMLImageElement) => image.naturalWidth),
					).toBeGreaterThan(1);
				} else if (
					file.mimeType.startsWith("audio/") ||
					file.mimeType.startsWith("video/")
				) {
					const player = viewer.locator(
						file.mimeType.startsWith("audio/") ? "audio" : "video",
					);
					await expect(player).toHaveAttribute("controls", "");
					expect(
						await player.evaluate((media: HTMLMediaElement) => media.paused),
					).toBe(true);
					await player.evaluate((media: HTMLMediaElement) => media.play());
					expect(
						await player.evaluate((media: HTMLMediaElement) => media.paused),
					).toBe(false);
					await player.evaluate((media: HTMLMediaElement) => media.pause());
				} else if (file.mimeType === "text/html") {
					await expect(viewer.locator("pre")).toHaveText(
						file.buffer.toString(),
					);
					await expect(viewer.locator("pre script")).toHaveCount(0);
				} else {
					await expect(
						viewer.getByText("This file is ready to download."),
					).toBeVisible();
					const saving = viewer.waitForEvent("download");
					await download.click();
					const saved = await saving;
					expect(saved.suggestedFilename()).toBe(file.name);
					expect(await readFile(await saved.path())).toEqual(file.buffer);
				}
				for (const width of [1100, 320, 360]) {
					await viewer.setViewportSize({ width, height: 800 });
					expect(
						await viewer.evaluate(
							() => document.documentElement.scrollWidth <= innerWidth,
						),
					).toBe(true);
					await shot(viewer, `viewer-${index}-${width}`, { fullPage: false });
				}
			} finally {
				await viewer.close();
			}
		}
		expect(unwanted).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		page.context().off("request", request);
		page.context().off("page", watch);
	}
});

test("direct links preserve the target through password unlock, navigation, reload and inline restore", async ({
	page,
	app,
	browser,
}) => {
	await createLibrary(page, app);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
	const backup = await recovery(page);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles(await imageFixture(page, "Target.png", 640, 960));
	await expect(page.getByRole("article")).toHaveCount(1);
	const { href } = await linkFor(page, "Target.png");
	const url = `${app.origin}/${href}`;
	// Replacing the sole app document leaves no donor, so the target needs unlock.
	await page.goto(url);
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeVisible();
	expect(page.url()).toBe(url);
	await page.getByLabel("Master password", { exact: true }).fill(PASSWORD);
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
	await expect(
		page.getByRole("img", { name: "Target.png", exact: true }),
	).toBeVisible();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(page.getByRole("searchbox")).toBeVisible();
	await page.goBack();
	await expect(
		page.getByRole("img", { name: "Target.png", exact: true }),
	).toBeVisible();
	expect(page.url()).toBe(url);
	await page.goForward();
	await expect(page.getByRole("searchbox")).toBeVisible();
	await page.goBack();
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeVisible();
	expect(page.url()).toBe(url);
	const context = await browser.newContext();
	try {
		const fresh = await context.newPage();
		await fresh.goto(url);
		await fresh.getByLabel("Master password", { exact: true }).fill(PASSWORD);
		await fresh
			.getByLabel("Confirm master password", { exact: true })
			.fill(PASSWORD);
		await fresh
			.getByRole("button", { name: "Create master password", exact: true })
			.click();
		await expect(
			fresh.getByRole("heading", { name: "Your encrypted library" }),
		).toBeVisible();
		await fresh.getByRole("button", { name: "Restore", exact: true }).click();
		await fresh.getByLabel("Recovery file", { exact: true }).setInputFiles({
			name: "recovery.msgpack",
			mimeType: "application/msgpack",
			buffer: backup,
		});
		await fresh.getByLabel("Recovery password", { exact: true }).fill(PASSWORD);
		await fresh
			.getByRole("button", { name: "Restore library", exact: true })
			.click();
		await expect(
			fresh.getByRole("img", { name: "Target.png", exact: true }),
		).toBeVisible();
		expect(fresh.url()).toBe(url);
	} finally {
		await context.close();
	}
});

test("invalid, missing and failed file links offer local errors and retry", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles(await imageFixture(page, "Retry.png", 960, 540));
	await expect(page.getByRole("article")).toHaveCount(1);
	const { href } = await linkFor(page, "Retry.png");
	const viewer = await page.context().newPage();
	let metadata = 0;
	viewer.on("request", (request) => {
		if (new URL(request.url()).pathname.endsWith("/meta")) {
			metadata++;
		}
	});
	try {
		await viewer.goto(`${app.origin}/?page=media&id=bad`);
		await expect(viewer.getByRole("alert")).toHaveText("Invalid media link.");
		expect(metadata).toBe(0);
		await viewer.goto(`${app.origin}/?page=media&id=${"a".repeat(64)}`);
		await expect(viewer.getByRole("alert")).toHaveText(
			"File not found in this library.",
		);
		await viewer.route(/\/api\/media\/[0-9a-f]{64}$/, (route) =>
			route.fulfill({
				status: 503,
				contentType: "application/msgpack",
				body: Buffer.from(encode({ error: "Transfer unavailable" })),
			}),
		);
		await viewer.goto(`${app.origin}/${href}`);
		await expect(viewer.getByRole("alert")).toHaveText("Transfer unavailable");
		await expect(
			viewer.getByRole("button", { name: "Download", exact: true }),
		).toBeDisabled();
		await viewer.setViewportSize({ width: 320, height: 800 });
		await shot(viewer, "viewer-error-320");
		const before = metadata;
		await viewer.unrouteAll();
		await viewer.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(viewer.getByRole("img", { name: /Retry/ })).toBeVisible();
		expect(metadata).toBe(before);
	} finally {
		await viewer.close();
	}
});

test("forgetting the identity cancels a loading viewer and ignores its late content", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles(await imageFixture(page, "Pending.png", 800, 600));
	await expect(page.getByRole("article")).toHaveCount(1);
	const { href } = await linkFor(page, "Pending.png");
	const viewer = await page.context().newPage();
	const entered = deferred();
	const release = deferred();
	const finished = deferred();
	await viewer.route(/\/api\/media\/[0-9a-f]{64}$/, async (route) => {
		try {
			const response = await route.fetch();
			entered.resolve();
			await release.promise;
			await route.fulfill({ response }).catch(() => {});
		} finally {
			finished.resolve();
		}
	});
	try {
		await viewer.goto(`${app.origin}/${href}`);
		await entered.promise;
		await expect(viewer.getByRole("status")).toContainText("Loading");
		for (const width of [320, 360]) {
			await viewer.setViewportSize({ width, height: 800 });
			await shot(viewer, `viewer-loading-${width}`, { fullPage: false });
		}
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await page.getByText("Forget this library", { exact: true }).click();
		page.once("dialog", (dialog) => dialog.accept());
		await page
			.getByRole("button", { name: "Forget library", exact: true })
			.click();
		await expect(
			viewer.getByRole("heading", { name: "Your encrypted library" }),
		).toBeVisible();
		release.resolve();
		await finished.promise;
		await expect(
			viewer.getByRole("region", { name: "File viewer" }),
		).toHaveCount(0);
		await expect(
			viewer.getByRole("img", { name: "Pending.png", exact: true }),
		).toHaveCount(0);
	} finally {
		release.resolve();
		await viewer.close();
	}
});
