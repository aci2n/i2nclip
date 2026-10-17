import type { Page } from "@playwright/test";
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
	await expect(page).toHaveURL(/page=library/);
	await expect(page.getByRole("article")).toHaveCount(2);
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	expect(await drop(page, "html", ["third.txt"])).toEqual({
		drag: true,
		drop: true,
	});
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
		page.getByRole("heading", { name: "Your library starts here" }),
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

test("a second drop cannot overlap an upload batch", async ({ page, app }) => {
	await createLibrary(page, app);
	await page.evaluate(() => {
		for (const name of ["accepted.txt", "busy.txt"]) {
			const dataTransfer = new DataTransfer();
			dataTransfer.items.add(new File([name], name, { type: "text/plain" }));
			document.body.dispatchEvent(
				new DragEvent("drop", {
					bubbles: true,
					cancelable: true,
					dataTransfer,
				}),
			);
		}
	});
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
	await expect(page.getByRole("article")).toHaveCount(1);
	await expect(
		page
			.getByRole("article")
			.getByText("accepted.txt", { exact: true })
			.first(),
	).toBeVisible();
});
