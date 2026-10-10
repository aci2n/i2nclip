import {
	audioFixture,
	createLibrary,
	expect,
	png,
	shot,
	test,
	videoFixture,
} from "./fixtures.js";

test("deleted cards stay visible and fade after success", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await page
		.locator("#files")
		.setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
	const card = page.locator(".card");
	await expect(card).toHaveCount(1);
	page.once("dialog", (dialog) => dialog.accept());
	await card.locator('[data-act="delete"]').click();
	await expect(card).toHaveClass(/deleted/);
	await expect(card).toHaveCSS("opacity", "0.2");
	await page.reload();
	await expect(page.locator(".card")).toHaveCount(0);
});

test("clearing the identity invalidates an open library", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await expect(
		page.getByRole("heading", { name: "Your library is empty", exact: true }),
	).toBeVisible();
	await page.evaluate(async () => {
		await browser.storage.session.clear();
		await browser.storage.local.clear();
	});
	await expect(page.locator("#setup")).toBeVisible();
});

test("tag edits preserve the preview and remain searchable", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await page
		.locator("#files")
		.setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
	const card = page.locator(".card");
	await expect(card).toHaveCount(1);
	await card.getByRole("button", { name: "Add tag to dot.png" }).click();
	await card.locator(".tags input").fill(" Vacation, dog ");
	await shot(page, "tag-editor");
	await page.setViewportSize({ width: 360, height: 740 });
	await shot(page, "tag-editor-narrow");
	await card.getByRole("button", { name: "Save tag", exact: true }).click();
	await expect(card.locator(".tag-text")).toHaveText(["Vacation", "dog"]);
	await expect(card.locator("output")).toBeHidden();
	await page.locator("#tags").fill("vacation");
	await page.locator("#tags").press("Enter");
	await expect(card.locator("strong")).toHaveText("dot.png");
	await page.getByRole("link", { name: "Settings" }).click();
	await page.getByRole("link", { name: "Library" }).click();
	await expect(page.locator("#tags")).toHaveValue("vacation");
	await expect(page.locator(".card strong")).toHaveText("dot.png");
	await expect(card.locator(".media img")).toBeVisible();
	await expect(card.locator(".tag-text")).toHaveText(["Vacation", "dog"]);
	await expect(
		card.getByRole("button", { name: "Add tag to dot.png" }),
	).toBeVisible();
	await page.locator("#tags").fill("missing");
	await page.locator("#tags").press("Enter");
	await expect(card).toHaveCount(0);
});

test("a failed content fetch can be retried", async ({ page, app }) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await page
		.locator("#files")
		.setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
	const card = page.locator(".card");
	await expect(card).toHaveCount(1);
	let requests = 0;
	await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
		requests++;
		if (requests === 1)
			await route.fulfill({ status: 503, body: "Temporary failure" });
		else await route.continue();
	});
	await card.locator("img").click();
	await expect(card.locator("output")).toHaveText("Temporary failure");
	await expect(page.locator("#full")).not.toBeVisible();
	await card.locator("img").click();
	await expect(page.locator("#full img")).toBeVisible();
	expect(requests).toBe(2);
});

test("empty library upload and clear-search actions work", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await expect(
		page.getByRole("heading", { name: "Your library is empty", exact: true }),
	).toBeVisible();
	await shot(page, "empty-library");
	const choosing = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Upload files", exact: true }).click();
	await (await choosing).setFiles({
		name: "dot.png",
		mimeType: "image/png",
		buffer: png,
	});
	await expect(page.locator(".card")).toHaveCount(1);
	await expect(page.locator(".card .tags input")).toBeHidden();
	await page.locator("#tags").fill("missing");
	await page.locator("#tags").press("Enter");
	await expect(
		page.getByRole("heading", { name: "No matching clips", exact: true }),
	).toBeVisible();
	await shot(page, "no-search-results");
	await page.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(page.locator("#tags")).toHaveValue("");
	await expect(page.locator(".card strong")).toHaveText("dot.png");
});

test("mixed media has consistent previews without narrow-screen overflow", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	const files = [];
	for (const [width, height, name] of [
		[960, 640, "Mountains.png"],
		[640, 960, "A long portrait filename that wraps onto a second line.png"],
		[1600, 360, "Panorama.png"],
	]) {
		const encoded = await page.evaluate(
			({ width, height }) => {
				const canvas = document.createElement("canvas");
				canvas.width = width;
				canvas.height = height;
				const context = canvas.getContext("2d");
				const gradient = context.createLinearGradient(0, 0, 0, height);
				gradient.addColorStop(0, "#8fbdc5");
				gradient.addColorStop(1, "#e5d5ab");
				context.fillStyle = gradient;
				context.fillRect(0, 0, width, height);
				context.fillStyle = "#e9c77a";
				context.beginPath();
				context.arc(
					width * 0.72,
					height * 0.26,
					Math.min(width, height) * 0.09,
					0,
					Math.PI * 2,
				);
				context.fill();
				context.fillStyle = "#466957";
				context.beginPath();
				context.moveTo(0, height);
				context.lineTo(0, height * 0.75);
				context.lineTo(width * 0.3, height * 0.38);
				context.lineTo(width * 0.6, height * 0.7);
				context.lineTo(width * 0.9, height * 0.5);
				context.lineTo(width, height * 0.65);
				context.lineTo(width, height);
				context.fill();
				return canvas.toDataURL("image/png").split(",")[1];
			},
			{ width, height },
		);
		files.push({
			name,
			mimeType: "image/png",
			buffer: Buffer.from(encoded, "base64"),
		});
	}
	files.push(audioFixture(), await videoFixture());
	files.push({
		name: "Notes.bin",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("file"),
	});
	await page.locator("#files").setInputFiles(files);
	await expect(page.locator(".card")).toHaveCount(6);
	const heights = await page
		.locator(".media")
		.evaluateAll((elements) =>
			elements.map((element) => element.getBoundingClientRect().height),
		);
	expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
	// The nested image button must fit inside the preview grid's single row.
	for (const image of await page.locator(".image-button img").all()) {
		const bounds = await image.evaluate((node) => ({
			image: node.getBoundingClientRect().height,
			preview: node.closest(".media").getBoundingClientRect().height,
		}));
		expect(bounds.image).toBeLessThanOrEqual(bounds.preview + 1);
	}
	await shot(page, "mixed-media");
	for (const width of [360, 320]) {
		await page.setViewportSize({ width, height: 740 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await shot(page, `mixed-media-${width}`);
	}
	const audio = page.locator(".card").filter({ hasText: "Voice memo.wav" });
	await audio.getByRole("button", { name: "Play Voice memo.wav" }).click();
	await expect(audio.locator("audio")).toBeVisible();
	await expect
		.poll(() => audio.locator("audio").evaluate((node) => node.readyState))
		.toBeGreaterThanOrEqual(2);
	const video = page.locator(".card").filter({ hasText: "Video.webm" });
	await video.getByRole("button", { name: "Play Video.webm" }).click();
	await expect(video.locator("video")).toBeVisible();
	await expect
		.poll(() => video.locator("video").evaluate((node) => node.readyState))
		.toBeGreaterThanOrEqual(2);
	await shot(page, "mixed-media-playing-320");
});

test("upload batches show filenames, continue after failure, and retry only failed files", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	let posts = 0;
	await page.route("**/api/media", async (route) => {
		if (route.request().method() === "POST" && ++posts === 1) {
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "Temporary failure" }),
			});
		} else await route.continue();
	});
	await page.locator("#files").setInputFiles([
		{ name: "retry.png", mimeType: "image/png", buffer: png },
		{ name: "saved.png", mimeType: "image/png", buffer: png },
	]);
	await expect(page.locator(".card strong")).toHaveText("saved.png");
	await expect(
		page.getByRole("region", { name: "Failed uploads" }),
	).toContainText("retry.png");
	await expect(page.locator("#status")).toBeEmpty();
	await shot(page, "upload-failure");
	await page.getByRole("button", { name: "Retry failed files" }).click();
	await expect(page.locator(".card")).toHaveCount(2);
	await expect(
		page.getByRole("region", { name: "Failed uploads" }),
	).toBeHidden();
	expect(posts).toBe(3);
});

for (const change of ["server", "reset"]) {
	test(`changing ${change} cancels a slow upload and the remaining batch`, async ({
		page,
		app,
	}) => {
		await createLibrary(page, app);
		await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
		let release, started;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const requestStarted = new Promise((resolve) => {
			started = resolve;
		});
		let posts = 0;
		await page.route("**/api/media", async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			posts++;
			started();
			await gate;
			await route
				.fulfill({ status: 503, body: "Old upload failure" })
				.catch(() => {});
		});
		try {
			await page.locator("#files").setInputFiles([
				{ name: "slow.png", mimeType: "image/png", buffer: png },
				{ name: "never-sent.png", mimeType: "image/png", buffer: png },
			]);
			await requestStarted;
			await expect(
				page.getByRole("region", { name: "Upload progress" }),
			).toContainText("Uploading 1 of 2: slow.png");
			await shot(page, "upload-progress");
			await page.evaluate(
				async ({ change, origin }) => {
					if (change === "server")
						await browser.storage.local.set({ serverUrl: `${origin}/changed` });
					else {
						await browser.storage.session.clear();
						await browser.storage.local.clear();
					}
				},
				{ change, origin: app.origin },
			);
			await expect(
				page.getByRole("region", { name: "Upload progress" }),
			).toBeHidden();
			if (change === "reset")
				await expect(page.locator("#setup")).toBeVisible();
			else
				await expect(
					page.getByRole("heading", { name: "Your library is empty" }),
				).toBeVisible();
		} finally {
			release();
		}
		await expect(
			page.getByRole("region", { name: "Failed uploads" }),
		).toBeHidden();
		expect(posts).toBe(1);
	});
}

test("inline tag saves deduplicate and guard a slow request", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await page
		.locator("#files")
		.setInputFiles({ name: "first.png", mimeType: "image/png", buffer: png });
	const card = page.locator(".card");
	await expect(card).toHaveCount(1);
	const add = card.getByRole("button", { name: "Add tag to first.png" });
	await add.focus();
	await add.press("Enter");
	const input = card.locator(".tags input");
	await expect(input).toBeFocused();
	await input.fill("Vacation, vacation, dog, DOG");
	let release, started;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const requestStarted = new Promise((resolve) => {
		started = resolve;
	});
	let saves = 0;
	await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		saves++;
		started();
		await gate;
		await route.continue();
	});
	try {
		await input.press("Enter");
		await requestStarted;
		await expect(card.getByRole("button", { name: "Save tag" })).toBeDisabled();
		await expect(
			card.getByRole("button", { name: "Delete", exact: true }),
		).toBeDisabled();
	} finally {
		release();
	}
	await expect(card.locator(".tag-text")).toHaveText(["Vacation", "dog"]);
	await expect(card.locator("output")).toBeHidden();
	await expect(input).toHaveValue("");
	await expect(input).toBeFocused();
	expect(saves).toBe(1);
});

test("uploads continue across Library and Settings views and retain progress", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	let release, started;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const requestStarted = new Promise((resolve) => {
		started = resolve;
	});
	await page.route("**/api/media", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		started();
		await gate;
		await route.continue();
	});
	try {
		await page
			.locator("#files")
			.setInputFiles({ name: "slow.png", mimeType: "image/png", buffer: png });
		await requestStarted;
		await expect(
			page.getByRole("region", { name: "Upload progress" }),
		).toContainText("Uploading 1 of 1: slow.png");
		await page.getByRole("link", { name: "Settings" }).click();
		await expect(page).toHaveURL(/options\.html$/);
		await page.getByRole("link", { name: "Library" }).click();
		await expect(page).toHaveURL(/library\.html$/);
		await expect(
			page.getByRole("region", { name: "Upload progress" }),
		).toContainText("Uploading 1 of 1: slow.png");
	} finally {
		release();
	}
	await expect(page.locator(".card strong")).toHaveText("slow.png");
	await expect(
		page.getByRole("region", { name: "Upload progress" }),
	).toBeHidden();
	await expect(page.locator("#status")).toBeEmpty();
});

test("decrypted card content survives navigating away from the Library", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await page
		.locator("#files")
		.setInputFiles({ name: "saved.png", mimeType: "image/png", buffer: png });
	const card = page.locator(".card");
	await expect(card.locator(".card-title")).toHaveText("saved.png");
	let contentRequests = 0;
	await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
		if (route.request().method() === "GET") contentRequests++;
		await route.continue();
	});
	await card.getByRole("button", { name: "Open saved.png" }).click();
	await expect(page.locator("#full")).toBeVisible();
	await page.locator("#full .close").click();
	const decryptedUrl = await card.locator(".media img").getAttribute("src");
	expect(decryptedUrl).toMatch(/^blob:/);
	expect(contentRequests).toBe(1);
	await page.getByRole("link", { name: "Settings" }).click();
	await page.getByRole("link", { name: "Library" }).click();
	const restoredCard = page.locator(".card");
	await expect(restoredCard.locator(".media img")).toHaveAttribute(
		"src",
		decryptedUrl,
	);
	expect(contentRequests).toBe(1);
});

test("a slow search cannot clear the newer search results", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await page
		.locator("#files")
		.setInputFiles({ name: "saved.png", mimeType: "image/png", buffer: png });
	await expect(page.locator(".card strong")).toHaveText("saved.png");
	let release, started, finished;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const requestStarted = new Promise((resolve) => {
		started = resolve;
	});
	const requestFinished = new Promise((resolve) => {
		finished = resolve;
	});
	await page.route("**/api/media?*", async (route) => {
		started();
		await gate;
		try {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ media: [], next: null }),
			});
		} catch {
			/* Superseded requests can already be cancelled by Firefox. */
		} finally {
			finished();
		}
	});
	try {
		await page.locator("#tags").fill("missing");
		await page.locator("#tags").press("Enter");
		await requestStarted;
		await page.locator("#tags").fill("");
		await page.locator("#tags").press("Enter");
		await expect(page.locator(".card strong")).toHaveText("saved.png");
	} finally {
		release();
	}
	await requestFinished;
	await expect(page.locator(".card strong")).toHaveText("saved.png");
	await expect(
		page.getByRole("heading", { name: "No matching clips" }),
	).toBeHidden();
});

test("inline tags keep failed drafts, allow repeated saves, close on blur, remove chips, and cancel", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
	await page.setViewportSize({ width: 320, height: 740 });
	await page
		.locator("#files")
		.setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
	const card = page.locator(".card");
	await expect(card).toHaveCount(1);
	let updates = 0;
	await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		if (++updates === 1)
			return route.fulfill({ status: 503, body: "Try again" });
		await route.continue();
	});
	const add = card.getByRole("button", { name: "Add tag to dot.png" });
	await add.click();
	const input = card.getByRole("textbox", { name: "New tag for dot.png" });
	await expect(input).toBeFocused();
	await input.fill("dog");
	await input.press("Enter");
	await expect(card.locator("output")).toHaveText("Try again");
	await expect(input).toHaveValue("dog");
	await expect(input).toBeFocused();
	await expect(card.locator(".tag-text")).toHaveCount(0);
	await input.press("Enter");
	await expect(card.locator(".tag-text")).toHaveText(["dog"]);
	await expect(input).toHaveValue("");
	await expect(input).toBeFocused();
	await input.fill("Cat");
	await card.getByRole("button", { name: "Save tag", exact: true }).click();
	await expect(card.locator(".tag-text")).toHaveText(["dog", "Cat"]);
	await expect(input).toHaveValue("");
	await expect(input).toBeFocused();
	await shot(page, "inline-tag-chips");
	await card
		.getByRole("button", { name: "Remove tag dog", exact: true })
		.click();
	await expect(card.locator(".tag-text")).toHaveText(["Cat"]);
	await expect(input).toBeFocused();
	await input.press("Escape");
	await expect(add).toBeFocused();
	await add.click();
	await input.fill("unsaved");
	await page.locator("#tags").focus();
	await expect(input).toBeHidden();
	await expect(add).toBeVisible();
	await expect(card.locator(".tag-text")).toHaveText(["Cat"]);
	expect(updates).toBe(4);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
});

test("history navigation keeps media and modal Escape restores focus", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.locator("#files")
		.setInputFiles({ name: "history.png", mimeType: "image/png", buffer: png });
	const open = page.getByRole("button", { name: "Open history.png" });
	await open.click();
	await expect(page.locator("#full")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator("#full")).toBeHidden();
	await expect(open).toBeFocused();
	const source = await page.locator(".card .media img").getAttribute("src");
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.goBack();
	await expect(page.locator(".card .media img")).toHaveAttribute("src", source);
	await expect(page.locator("#full")).toBeHidden();
	await page.goForward();
	await expect(page.locator("#configured")).toBeVisible();
});

test("a tag draft survives a failed save after focus leaves the editor", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page
		.locator("#files")
		.setInputFiles({ name: "tags.png", mimeType: "image/png", buffer: png });
	await page.getByRole("button", { name: "Add tag to tags.png" }).click();
	const input = page.getByRole("textbox", { name: "New tag for tags.png" });
	await input.fill("keep this draft");
	let release, started;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const requestStarted = new Promise((resolve) => {
		started = resolve;
	});
	await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		started();
		await gate;
		await route.fulfill({ status: 503, body: "Try again" });
	});
	try {
		await input.press("Enter");
		await requestStarted;
		await page.locator("#tags").focus();
	} finally {
		release();
	}
	await expect(page.locator(".card output")).toHaveText("Try again");
	await expect(input).toHaveValue("keep this draft");
	await expect(page.locator("#tags")).toBeFocused();
	await shot(page, "tag-error");
});

test("damaged metadata leaves a browsable card with working download and delete actions", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.locator("#files").setInputFiles({
		name: "metadata.png",
		mimeType: "image/png",
		buffer: png,
	});
	await expect(page.locator(".card-title")).toHaveText("metadata.png");
	await page.route("**/api/media", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const response = await route.fetch();
		const json = await response.json();
		json.media[0].meta = "AAAA";
		await route.fulfill({ response, json });
	});
	await page.reload();
	const card = page.locator(".card");
	await expect(card).toHaveCount(1);
	await expect(card.locator(".file-type")).toHaveText("FILE");
	await expect(card.locator("fieldset")).toHaveCount(0);
	await card.getByRole("button", { name: "Download", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.lastDownload?.length))
		.toBeGreaterThan(0);
	await shot(page, "damaged-metadata");
	page.once("dialog", (dialog) => dialog.accept());
	await card.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(card).toHaveClass(/deleted/);
});

test("reencryption after a lost upload response creates a separate content hash", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	let posts = 0;
	await page.route("**/api/media", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		if (++posts === 1) {
			await route.fetch();
			return route.abort("failed");
		}
		return route.continue();
	});
	await page.locator("#files").setInputFiles({
		name: "saved-once.png",
		mimeType: "image/png",
		buffer: png,
	});
	const failed = page.getByRole("region", { name: "Failed uploads" });
	await expect(failed).toContainText("Upload failed.");
	await page.getByRole("button", { name: "Retry failed files" }).click();
	await expect(failed).toBeHidden();
	await page.locator("#find button[type=submit]").click();
	await expect(page.locator(".card-title")).toHaveText([
		"saved-once.png",
		"saved-once.png",
	]);
	await expect(page.locator(".card")).toHaveCount(2);
	expect(posts).toBe(2);
});
