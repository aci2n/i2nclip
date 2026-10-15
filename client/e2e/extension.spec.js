import { readFile } from "node:fs/promises";
import {
	createLibrary,
	expect,
	imageFixture,
	master,
	shot,
	test,
} from "./fixtures.js";

// Exercise the app's public event interface; this page has no extension APIs.
function receiveCapture(page, request, timeout = 5000) {
	return page.evaluate(
		({ request, timeout }) =>
			new Promise((resolve) => {
				if (request.type === "file") {
					request = {
						type: "file",
						file: new File([new Uint8Array(request.bytes)], request.name, {
							type: request.mime,
						}),
					};
				}
				const token = crypto.randomUUID();
				const finish = (result) => {
					clearTimeout(timer);
					window.removeEventListener("message", reply);
					resolve(result);
				};
				const reply = (event) => {
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
	};
	await page.getByRole("button", { name: "Lock", exact: true }).click();
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
		expect(await receiveCapture(other, { type: "probe" }, 50)).toMatchObject({
			ok: false,
			unavailable: true,
		});
	} finally {
		await other.close();
	}
});
