import type { Page } from "@playwright/test";
import { deferred } from "../tests/helpers.ts";
import { createLibrary, expect, master, test } from "./fixtures.ts";

async function drop(page: Page, target: string, names: string[]) {
	return page
		.locator(target)
		.first()
		.evaluate((element, names) => {
			const dataTransfer = new DataTransfer();
			for (const name of names) {
				dataTransfer.items.add(new File([name], name, { type: "text/plain" }));
			}
			const drag = new DragEvent("dragover", {
				bubbles: true,
				cancelable: true,
				dataTransfer,
			});
			const drop = new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer,
			});
			element.dispatchEvent(drag);
			element.dispatchEvent(drop);
			return { drag: drag.defaultPrevented, drop: drop.defaultPrevented };
		}, names);
}

test("file drops upload batches from Settings and outside main", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	expect(await drop(page, "header a", ["first.txt", "second.txt"])).toEqual({
		drag: true,
		drop: true,
	});
	await expect(page).toHaveURL(/#\/library/);
	await expect(
		page.getByRole("button", { name: "Start upload", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Open first.txt", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(2);
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	expect(await drop(page, "html", ["third.txt"])).toEqual({
		drag: true,
		drop: true,
	});
	await expect(
		page.getByRole("button", { name: "Open third.txt", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(3);
	for (const name of ["first.txt", "second.txt", "third.txt"]) {
		await expect(
			page.getByRole("article").getByText(name, { exact: true }).first(),
		).toBeVisible();
	}
});

test("file drops are suppressed before setup and while locked; text drags are untouched", async ({
	page,
	app,
}) => {
	await page.goto(app.origin);
	expect(await drop(page, "html", ["locked.txt"])).toEqual({
		drag: true,
		drop: true,
	});
	await master(page);
	expect(await drop(page, "main", ["unconfigured.txt"])).toEqual({
		drag: true,
		drop: true,
	});
	await expect(
		page.getByRole("heading", { name: "Set up your library" }),
	).toBeVisible();
	expect(
		await page.evaluate(() => {
			const dataTransfer = new DataTransfer();
			dataTransfer.setData("text/plain", "ordinary text");
			return ["dragover", "drop"].map((type) => {
				const event = new DragEvent(type, {
					bubbles: true,
					cancelable: true,
					dataTransfer,
				});
				document.body.dispatchEvent(event);
				return event.defaultPrevented;
			});
		}),
	).toEqual([false, false]);
});

test("a second drop joins the running upload batch", async ({ page, app }) => {
	await createLibrary(page, app);
	const held = deferred();
	const started = deferred();
	await page.route("**/api/blobs", async (route) => {
		if (route.request().method() === "POST") {
			started.resolve();
			await held.promise;
		}
		await route.continue().catch(() => {});
	});
	try {
		await drop(page, "html", ["accepted.txt"]);
		await started.promise;
		await drop(page, "html", ["joined.txt"]);
		held.resolve();
		for (const name of ["accepted.txt", "joined.txt"]) {
			await expect(
				page.getByRole("button", { name: `Open ${name}`, exact: true }),
			).toBeVisible();
		}
		await expect(page.getByRole("article")).toHaveCount(2);
	} finally {
		held.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("pasted files upload immediately while text-field paste stays local", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const paste = async (target: string) =>
		page.locator(target).evaluate((element) => {
			const clipboardData = new DataTransfer();
			clipboardData.items.add(
				new File(["pasted text"], "pasted.txt", { type: "text/plain" }),
			);
			// Firefox ignores ClipboardEventInit.clipboardData on synthetic events.
			const event = new Event("paste", {
				bubbles: true,
				cancelable: true,
			});
			Object.defineProperty(event, "clipboardData", { value: clipboardData });
			element.dispatchEvent(event);
			return event.defaultPrevented;
		});
	expect(await paste("input[type=search]")).toBe(false);
	await expect(
		page.getByRole("button", { name: "Start upload", exact: true }),
	).toHaveCount(0);
	expect(await paste("body")).toBe(true);
	await expect(
		page.getByRole("button", { name: "Open pasted.txt", exact: true }),
	).toBeVisible();
});
