import { encode } from "../src/lib/protocol/msgpack.js";
import { deferred } from "../tests/helpers.js";
import { createLibrary, expect, shot, test } from "./fixtures.js";

const textFile = (name) => ({
	name,
	mimeType: "text/plain",
	buffer: Buffer.from(name),
});

test("chip search applies on Enter, clears draft and filters, and stays separate from Upload", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Your library is empty" }),
	).toBeVisible();
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles([textFile("alpha.txt"), textFile("beta.txt")]);
	await expect(page.getByRole("article")).toHaveCount(2);
	const uploads = page.getByRole("region", { name: "Uploads", exact: true });
	await expect(
		uploads.getByText("2 files uploaded", { exact: true }),
	).toBeVisible();
	await expect(
		uploads.getByText("alpha.txt", { exact: true }),
	).not.toBeVisible();
	await uploads.getByText("2 files uploaded", { exact: true }).click();
	await expect(uploads.getByText("alpha.txt", { exact: true })).toBeVisible();
	await uploads.getByText("2 files uploaded", { exact: true }).click();
	const alpha = page.getByRole("article").filter({
		has: page.getByRole("button", { name: "Open alpha.txt", exact: true }),
	});
	await alpha
		.getByRole("button", { name: "Add tag to alpha.txt", exact: true })
		.click();
	const tag = alpha.getByRole("textbox", {
		name: "New tag for alpha.txt",
		exact: true,
	});
	await tag.fill("Work");
	await tag.press("Enter");
	await expect(alpha.locator(".tag-text")).toHaveText([
		"text",
		"txt",
		"alpha",
		"Work",
	]);
	await tag.press("Escape");
	const searches = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (request.method() === "GET" && url.pathname === "/api/media") {
			searches.push(url);
		}
	});
	const search = page.getByRole("searchbox");
	await search.fill("Work");
	expect(searches).toHaveLength(0);
	const choosing = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Upload", exact: true }).click();
	await (await choosing).setFiles(textFile("gamma.txt"));
	await expect(page.getByRole("article")).toHaveCount(3);
	expect(searches).toHaveLength(1);
	expect(searches[0].searchParams.has("tag")).toBe(false);
	await search.press("Enter");
	await expect(page.getByRole("article")).toHaveCount(1);
	await expect(
		page.getByRole("button", { name: "Remove search tag Work", exact: true }),
	).toBeVisible();
	for (const width of [1100, 360, 320]) {
		await page.setViewportSize({ width, height: 800 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		for (const name of ["Clear search", "Upload"]) {
			const box = await page
				.getByRole("button", { name, exact: true })
				.boundingBox();
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);
		}
		await shot(page, `toolbar-filtered-${width}`);
	}
	await search.fill("missing");
	expect(searches).toHaveLength(2);
	await search.press("Enter");
	await expect(
		page.getByRole("heading", { name: "No files match your search" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Show all files", exact: true }),
	).toBeVisible();
	await search.fill("");
	await page.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(search).toBeFocused();
	await expect(search).toHaveValue("");
	await expect(page.getByRole("article")).toHaveCount(3);
	await expect(
		page.getByRole("button", { name: "Clear search", exact: true }),
	).toHaveCount(0);
	await shot(page, "toolbar-cleared-320");
});

test("compact upload summary shows progress and keeps failures visible when successes are collapsed or dismissed", async ({
	page,
	app,
}) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const waiting = deferred();
	let posts = 0;
	await page.route("**/api/media", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		posts++;
		if (posts === 1) {
			await route.fulfill({
				status: 503,
				contentType: "application/msgpack",
				body: Buffer.from(encode({ error: "Upload unavailable" })),
			});
		} else {
			await waiting.promise;
			await route.continue();
		}
	});
	const longName =
		"A long descriptive filename that must fit on a narrow phone screen.txt";
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles([textFile("failed.txt"), textFile(longName)]);
	const uploads = page.getByRole("region", { name: "Uploads", exact: true });
	try {
		await expect.poll(() => posts).toBe(2);
		await expect(uploads.getByRole("status")).toContainText("Uploading 2 of 2");
		await expect(
			uploads.getByRole("progressbar", { name: "Upload progress" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Upload", exact: true }),
		).toBeDisabled();
		await shot(page, "toolbar-uploading-320");
	} finally {
		waiting.resolve();
	}
	await expect(page.getByRole("article")).toHaveCount(1);
	await expect(
		uploads.getByText("1 file uploaded", { exact: true }),
	).toBeVisible();
	await expect(uploads.getByRole("alert")).toHaveText(
		"failed.txt: Upload unavailable",
	);
	await expect(uploads.getByText(longName, { exact: true })).not.toBeVisible();
	await shot(page, "toolbar-upload-error-320");
	await uploads
		.getByRole("button", { name: "Dismiss completed uploads", exact: true })
		.click();
	await expect(uploads.getByRole("alert")).toHaveText(
		"failed.txt: Upload unavailable",
	);
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
});
