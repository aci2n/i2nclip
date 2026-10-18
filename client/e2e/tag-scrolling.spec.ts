import type { Locator, Page } from "@playwright/test";
import { assertPresent } from "../tests/assert.ts";
import { createLibrary, expect, shot, test } from "./fixtures.ts";

async function scrollSuggestions(
	page: Page,
	input: Locator,
	scope: Locator,
	name: string,
) {
	await input.fill("suggest");
	const list = scope.getByRole("list", {
		name: "Tag suggestions",
		exact: true,
	});
	const buttons = list.getByRole("button");
	await expect(buttons).toHaveCount(10);
	await list.scrollIntoViewIfNeeded();
	const dimensions = await list.evaluate((node) => ({
		client: node.clientHeight,
		scroll: node.scrollHeight,
		height: node.getBoundingClientRect().height,
	}));
	expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
	expect(dimensions.height).toBeLessThanOrEqual(
		(await page.evaluate(() =>
			Math.min(
				15 *
					Number.parseFloat(
						getComputedStyle(document.documentElement).fontSize,
					),
				0.4 * innerHeight,
			),
		)) + 1,
	);
	const box = await list.boundingBox();
	await page.mouse.move(
		assertPresent(box).x + assertPresent(box).width / 2,
		assertPresent(box).y + assertPresent(box).height / 2,
	);
	await page.mouse.wheel(0, 2000);
	await expect
		.poll(() => list.evaluate((node) => node.scrollTop))
		.toBeGreaterThan(0);
	await expect
		.poll(async () => {
			const bottom = await list.evaluate(
				(node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
			);
			if (!bottom) {
				await page.mouse.wheel(0, 1000);
			}
			return bottom;
		})
		.toBe(true);
	const pageTop = await page.evaluate(() => scrollY);
	await page.mouse.wheel(0, 2000);
	// Follow the wheel with a keyboard event before measuring scroll containment.
	await input.focus();
	await input.press("ArrowDown");
	await expect(buttons.first()).toBeFocused();
	expect(await page.evaluate(() => scrollY)).toBe(pageTop);
	for (let index = 1; index < 10; index++) {
		await page.keyboard.press("ArrowDown");
	}
	await expect(buttons.last()).toBeFocused();
	await expect
		.poll(() => list.evaluate((node) => node.scrollTop))
		.toBeGreaterThan(0);
	await expect
		.poll(() =>
			list.evaluate((node) => {
				function assertPresent<T>(value: T | null | undefined): T {
					if (value === null || value === undefined) {
						throw new Error("Required test value is missing.");
					}
					return value;
				}
				const menu = node.getBoundingClientRect();
				const last = assertPresent(
					node.querySelector("li:last-child button"),
				).getBoundingClientRect();
				return last.top >= menu.top - 1 && last.bottom <= menu.bottom + 1;
			}),
		)
		.toBe(true);
	await shot(page, `${name}-last-suggestion`);
	await page.keyboard.press("Tab");
	await expect(list).toHaveCount(0);
	await input.focus();
	await input.press("Tab");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(buttons.nth(1)).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(buttons.first()).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(input).toBeFocused();
	await input.press("Escape");
	await expect(list).toHaveCount(0);
	await expect(input).toHaveValue("suggest");
}
test("autocomplete scrolls with wheel and keyboard in search and tag editing", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const source = `${Array.from({ length: 10 }, (_, i) => `suggest0${i}`).join(" ")}.txt`;
	await page.getByLabel("Upload", { exact: true }).setInputFiles(
		[source, "Target.txt"].map((name) => ({
			name,
			mimeType: "text/plain",
			buffer: Buffer.from(name),
		})),
	);
	await page.getByRole("button", { name: "Start upload", exact: true }).click();
	await expect(page.getByRole("article")).toHaveCount(2);
	const search = page.getByRole("searchbox", {
		name: "Search tags",
		exact: true,
	});
	const form = page.getByRole("form", { name: "Search library", exact: true });
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: width === 320 ? 500 : 800 });
		await scrollSuggestions(page, search, form, `search-${width}`);
	}
	await search.press("ArrowDown");
	for (let index = 1; index < 10; index++) {
		await page.keyboard.press("ArrowDown");
	}
	await page.keyboard.press("Enter");
	await expect(
		form.getByRole("button", {
			name: "Remove search tag suggest09",
			exact: true,
		}),
	).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(1);
	await form.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(page.getByRole("article")).toHaveCount(2);
	const target = page.getByRole("article").filter({ hasText: "Target.txt" });
	await target
		.getByRole("button", { name: "Add tag to Target.txt", exact: true })
		.click();
	const editor = target.getByRole("textbox", {
		name: "New tag for Target.txt",
		exact: true,
	});
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: width === 320 ? 500 : 800 });
		await scrollSuggestions(page, editor, target, `editor-${width}`);
	}
	await editor.press("ArrowDown");
	for (let index = 1; index < 10; index++) {
		await page.keyboard.press("ArrowDown");
	}
	await page.keyboard.press("Enter");
	await expect(
		target.getByRole("button", { name: "Remove tag suggest09", exact: true }),
	).toBeVisible();
	await expect(editor).toHaveValue("");
	await expect(editor).toBeFocused();
});
