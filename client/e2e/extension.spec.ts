import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { BridgeReply } from "../extension/types.d.ts";
import {
	createLibrary,
	expect,
	imageFixture,
	master,
	shot,
	test,
} from "./fixtures.ts";

// Exercise the app's public event interface; this page has no extension APIs.
function receiveCapture(
	page: Page,
	request: {
		type: string;
		name?: string;
		mime?: string;
		bytes?: number[];
		file?: File;
		extra?: { sourceUrl: string; sourceTitle: string };
	},
	timeout = 5000,
) {
	return page.evaluate(
		({ request, timeout }) =>
			new Promise<BridgeReply>((resolve) => {
				if (request.type === "file") {
					request = {
						type: "file",
						extra: request.extra,
						file: new File(
							[new Uint8Array(request.bytes || [])],
							request.name || "capture",
							{
								type: request.mime,
							},
						),
					};
				}
				const token = crypto.randomUUID();
				const finish = (result: BridgeReply) => {
					clearTimeout(timer);
					window.removeEventListener("message", reply);
					resolve(result);
				};
				const reply = (event: MessageEvent) => {
					if (
						event.source === window &&
						event.origin === location.origin &&
						event.data?.channel === "i2nclip-extension-v1" &&
						event.data?.type === "reply" &&
						event.data?.token === token
					) {
						finish(event.data.result);
					}
				};
				const timer = setTimeout(
					() => finish({ ok: false, unavailable: true }),
					timeout,
				);
				window.addEventListener("message", reply);
				window.postMessage(
					{ ...request, channel: "i2nclip-extension-v1", token },
					location.origin,
				);
			}),
		{ request, timeout },
	);
}

test("app receives captures through its public event interface and uploads after unlock", async ({
	page,
	app,
	context,
}) => {
	await createLibrary(page, app);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
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
		bytes: [...image.buffer],
		extra: {
			sourceUrl: "https://example.com/gallery?photo=42#portrait",
			sourceTitle: "A portrait from the mountain trail",
		},
	};
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeVisible();
	const deliver = () => receiveCapture(page, request);
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
	await card.getByText("File details", { exact: true }).click();
	const source = card.getByRole("link", {
		name: request.extra.sourceTitle,
	});
	await expect(source).toHaveAttribute("href", request.extra.sourceUrl);
	await expect(source).toHaveAttribute("rel", "noreferrer");
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	expect(await readFile(await (await downloading).path())).toEqual(
		image.buffer,
	);

	// An unlocked app immediately uploads and returns to Library from Settings.
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	expect(
		await receiveCapture(page, { ...request, name: "Second portrait.png" }),
	).toEqual({ ok: true, needsUnlock: false });
	await expect(page.getByRole("searchbox")).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(2);

	await page.reload();
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeVisible();
	expect(await deliver()).toEqual({ ok: true, needsUnlock: true });
	// Reload discards a hidden capture rather than uploading it after unlock.
	await page.reload();
	await master(page);
	await expect(page.getByRole("article")).toHaveCount(2);

	// Each tab owns its receiver and inherits unlocked access.
	const other = await context.newPage();
	try {
		await other.goto(app.origin);
		await expect(
			other.getByRole("navigation", { name: "Main navigation" }),
		).toBeVisible();
		expect(await receiveCapture(other, { type: "probe" }, 50)).toMatchObject({
			ok: true,
			needsUnlock: false,
		});
	} finally {
		await other.close();
	}
});

test("a capture pending on a fresh media route creates uploads synchronously after unlock", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.origin}/?page=media&id=${"a".repeat(64)}`);
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeVisible();
	expect(
		await receiveCapture(page, {
			type: "file",
			name: "pending-capture.txt",
			mime: "text/plain",
			bytes: [...Buffer.from("captured while the viewer was locked")],
		}),
	).toEqual({ ok: true, needsUnlock: true });
	await master(page);
	await expect(page).toHaveURL(/\?page=library$/);
	await expect(
		page
			.getByRole("article")
			.getByText("pending-capture.txt", { exact: true })
			.first(),
	).toBeVisible();
});
