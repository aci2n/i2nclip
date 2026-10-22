import { encode } from "../src/lib/protocol/msgpack.ts";
import { deferred } from "../tests/helpers.ts";
import { createLibrary, expect, shot, test } from "./fixtures.ts";

const textFile = (name: string) => ({
	name,
	mimeType: "text/plain",
	buffer: Buffer.from(name),
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
	await page.route("**/api/blobs", async (route) => {
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
		).toBeEnabled();
		await shot(page, "toolbar-uploading-320");
	} finally {
		waiting.resolve();
	}
	await expect(page.getByRole("article")).toHaveCount(1);
	await expect(
		uploads.getByText("1 file uploaded", { exact: true }),
	).toBeVisible();
	await expect(uploads.getByRole("alert")).toHaveText(
		"failed.txt: Server request failed (HTTP 503).",
	);
	await expect(uploads.getByText(longName, { exact: true })).not.toBeVisible();
	await shot(page, "toolbar-upload-error-320");
	await uploads
		.getByRole("button", { name: "Dismiss completed uploads", exact: true })
		.click();
	await expect(uploads.getByRole("alert")).toHaveText(
		"failed.txt: Server request failed (HTTP 503).",
	);
	await expect(
		page.getByRole("button", { name: "Upload", exact: true }),
	).toBeEnabled();
});
