import { createLibrary, expect, shot, test } from "./fixtures.js";

test("Backspace in an empty search removes the last tag without interfering with text editing", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(
		["Summer.txt", "Winter.txt"].map((name) => ({
			name,
			mimeType: "text/plain",
			buffer: Buffer.from(name),
		})),
	);
	await expect(page.getByRole("article")).toHaveCount(2);
	const search = page.getByRole("searchbox", {
		name: "Search tags",
		exact: true,
	});
	const form = page.getByRole("form", { name: "Search library", exact: true });
	const chips = form.getByRole("button", { name: /^Remove search tag / });
	for (const tag of ["text", "summer"]) {
		await search.fill(tag);
		await search.press("Enter");
	}
	await expect(chips).toHaveCount(2);
	await expect(page.getByRole("article")).toHaveCount(1);
	await search.fill("x");
	await search.press("Backspace");
	await expect(search).toHaveValue("");
	await expect(chips).toHaveCount(2);
	await search.dispatchEvent("keydown", {
		key: "Backspace",
		isComposing: true,
	});
	await expect(chips).toHaveCount(2);
	await search.fill(" ");
	await search.press("Backspace");
	await expect(chips).toHaveCount(2);
	await search.press("Backspace");
	await expect(chips).toHaveCount(1);
	await expect(chips).toHaveAccessibleName("Remove search tag text");
	await expect(page.getByRole("article")).toHaveCount(2);
	await expect(search).toBeFocused();
	const cleared = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return url.pathname === "/api/media" && !url.searchParams.has("tag");
	});
	await search.press("Backspace");
	await cleared;
	await expect(chips).toHaveCount(0);
	await expect(search).toBeFocused();
	const requests = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/media") {
			requests.push(request);
		}
	});
	await search.press("Backspace");
	await expect(search).toHaveValue("");
	await expect(page.getByRole("article")).toHaveCount(2);
	expect(requests).toHaveLength(0);
});

test("private suggestions build immediate AND-search chips with keyboard and pointer controls", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(
		["Summer holiday.txt", "Winter notes.txt"].map((name) => ({
			name,
			mimeType: "text/plain",
			buffer: Buffer.from(name),
		})),
	);
	await expect(page.getByRole("article")).toHaveCount(2);
	const search = page.getByRole("searchbox", { name: "Search tags" });
	const form = page.getByRole("form", { name: "Search library" });
	const requests = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname === "/api/media" && request.method() === "GET") {
			requests.push(url);
		}
	});
	await search.fill("sum");
	const suggestion = form.getByRole("button", { name: "summer", exact: true });
	await expect(suggestion).toBeVisible();
	expect(requests).toHaveLength(0);
	await search.press("ArrowDown");
	await expect(suggestion).toBeFocused();
	await suggestion.press("ArrowUp");
	await expect(search).toBeFocused();
	await search.press("Escape");
	await expect(suggestion).toHaveCount(0);
	await expect(search).toHaveValue("sum");
	await search.press("ArrowDown");
	await suggestion.press("Escape");
	await expect(suggestion).toHaveCount(0);
	await expect(search).toBeFocused();
	await search.press("ArrowDown");
	await suggestion.press("Enter");
	await expect(page.getByRole("article")).toHaveCount(1);
	await expect(search).toHaveValue("");
	await search.fill("tex");
	await form.getByRole("button", { name: "text", exact: true }).click();
	await expect(
		form.getByRole("button", { name: "Remove search tag text", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(1);
	await form
		.getByRole("button", { name: "Remove search tag summer", exact: true })
		.click();
	await expect(page.getByRole("article")).toHaveCount(2);
	await form.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(search).toBeFocused();
	const summer = page
		.getByRole("article")
		.filter({ hasText: "Summer holiday.txt" });
	await summer
		.getByRole("button", { name: "Add tag to Summer holiday.txt", exact: true })
		.click();
	const editor = summer.getByRole("textbox", {
		name: "New tag for Summer holiday.txt",
		exact: true,
	});
	await editor.fill("Summer holiday");
	await editor.press("Enter");
	await expect(editor).toHaveValue("");
	await editor.press("Escape");
	await search.fill("summer h");
	await form
		.getByRole("button", { name: "Summer holiday", exact: true })
		.click();
	await expect(page.getByRole("article")).toHaveCount(1);
	await search.fill("SUMMER HOLIDAY");
	await expect(
		form.getByRole("button", { name: "SUMMER HOLIDAY", exact: true }),
	).toHaveCount(0);
	await search.press("Enter");
	await expect(
		form.getByRole("button", {
			name: "Remove search tag Summer holiday",
			exact: true,
		}),
	).toHaveCount(1);
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await search.fill("tex");
		await expect(
			form.getByRole("button", { name: "text", exact: true }),
		).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await shot(page, `chip-suggestions-${width}`);
	}
	await search.fill("no such tag");
	await search.press("Enter");
	await expect(
		page.getByRole("heading", {
			name: "No files match your search",
			exact: true,
		}),
	).toBeVisible();
	await form.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(page.getByRole("article")).toHaveCount(2);
});
