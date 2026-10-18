import type { Request } from "@playwright/test";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { assertPresent } from "../tests/assert.ts";
import { deferred } from "../tests/helpers.ts";
import { createLibrary, expect, imageFixture, shot, test } from "./fixtures.ts";

test("preview opens immediately and arrows, keys, swipes and close cancel stalled loads", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles([
			await imageFixture(page, "Landscape.png", 960, 540),
			await imageFixture(page, "Portrait.png", 360, 640),
		]);
	await expect(page.getByRole("article")).toHaveCount(2);
	await page.getByRole("button", { name: "Dismiss completed uploads" }).click();
	const held: {
		gate: ReturnType<typeof deferred<string | undefined>>;
		request: Request;
	}[] = [];
	const failed = new Set();
	page.on("requestfailed", (request) => failed.add(request));
	await page.route(
		/\/api\/media\/[0-9a-f]{64}\/chunks\/\d+$/,
		async (route) => {
			const gate = deferred<string | undefined>();
			held.push({ gate, request: route.request() });
			const response = await route.fetch({ timeout: 10000 });
			const outcome = await gate.promise;
			if (outcome === "error") {
				await route
					.fulfill({
						status: 503,
						contentType: "application/msgpack",
						body: Buffer.from(encode({ error: "Preview unavailable" })),
					})
					.catch(() => {});
			} else {
				await route.fulfill({ response }).catch(() => {});
			}
		},
	);
	const openers = page
		.getByRole("article")
		.getByRole("button", { name: /^Open / });
	const firstName = assertPresent(
		await openers.first().getAttribute("aria-label"),
	).slice(5);
	const secondName = assertPresent(
		await openers.last().getAttribute("aria-label"),
	).slice(5);
	const dialog = page.getByRole("dialog", { name: "Media preview" });
	const next = dialog.getByRole("button", { name: "Next media", exact: true });
	const previous = dialog.getByRole("button", {
		name: "Previous media",
		exact: true,
	});
	const close = dialog.getByRole("button", {
		name: "Close preview",
		exact: true,
	});
	const loading = async (name: string, count: number) => {
		await expect.poll(() => held.length).toBe(count);
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("status")).toContainText(name);
		await expect(dialog.getByRole("status")).toContainText("Loading");
		await expect(dialog.getByRole("img", { name, exact: true })).toBeVisible();
		await expect(close).toBeEnabled();
	};
	const swipe = async (dx: number, dy: number) => {
		const status = dialog.getByRole("status");
		const box = await status.boundingBox();
		const start = {
			pointerType: "touch",
			pointerId: 1,
			isPrimary: true,
			clientX: assertPresent(box).x + assertPresent(box).width / 2,
			clientY: assertPresent(box).y + assertPresent(box).height / 2,
		};
		await status.dispatchEvent("pointerdown", start);
		await status.dispatchEvent("pointerup", {
			...start,
			clientX: start.clientX + dx,
			clientY: start.clientY + dy,
		});
	};
	try {
		await openers.first().click();
		await loading(firstName, 1);
		await expect(next).toBeEnabled();
		for (const width of [1100, 320]) {
			await page.setViewportSize({ width, height: 800 });
			await shot(page, `preview-loading-${width}`);
		}
		await next.click();
		await loading(secondName, 2);
		await expect(
			dialog.getByRole("img", { name: firstName, exact: true }),
		).toHaveCount(0);
		await expect.poll(() => failed.has(held[0].request)).toBe(true);
		await expect(previous).toBeEnabled();
		await page.keyboard.press("ArrowLeft");
		await loading(firstName, 3);
		await expect.poll(() => failed.has(held[1].request)).toBe(true);
		held[2].gate.resolve(undefined);
		await expect(dialog.getByRole("status")).toHaveCount(0);
		// Late responses from canceled loads must not replace the current item.
		held[0].gate.resolve(undefined);
		held[1].gate.resolve("error");
		await expect(
			dialog.getByRole("img", { name: firstName, exact: true }),
		).toBeVisible();
		await next.click();
		await loading(secondName, 4);
		await swipe(100, 0);
		await expect(dialog.getByRole("status")).toHaveCount(0);
		await expect(
			dialog.getByRole("img", { name: firstName, exact: true }),
		).toBeVisible();
		await expect.poll(() => failed.has(held[3].request)).toBe(true);
		await next.click();
		await loading(secondName, 5);
		await close.click();
		await expect(dialog).not.toBeVisible();
		await expect(openers.first()).toBeFocused();
		await expect.poll(() => failed.has(held[4].request)).toBe(true);
		await openers.last().click();
		await loading(secondName, 6);
		await swipe(0, -100);
		await expect(dialog).not.toBeVisible();
		await expect(openers.last()).toBeFocused();
		await expect.poll(() => failed.has(held[5].request)).toBe(true);
		await openers.last().click();
		await loading(secondName, 7);
		held[6].gate.resolve("error");
		await expect(dialog.getByRole("alert")).toHaveText("Preview unavailable");
		await expect(previous).toBeEnabled();
		await dialog.getByRole("button", { name: "Retry", exact: true }).click();
		await loading(secondName, 8);
		held[7].gate.resolve(undefined);
		await expect(dialog.getByRole("status")).toHaveCount(0);
		await close.click();
		await openers.first().click();
		await expect(dialog.getByRole("status")).toHaveCount(0);
		expect(held.length).toBe(8);
	} finally {
		for (const entry of held) {
			entry.gate.resolve(undefined);
		}
		await page.unrouteAll({ behavior: "wait" });
	}
});
