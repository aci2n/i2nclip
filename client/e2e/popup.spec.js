import {
	createLibrary,
	expect,
	PASSWORD,
	png,
	storage,
	test,
} from "./fixtures.js";

test("upload popup keeps its pending source after failure and retries once", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const srcUrl = `${app.web.origin}/remote.png`;
	await page.route("**/remote.png", (route) =>
		route.fulfill({ contentType: "image/png", body: png }),
	);
	await page.evaluate(
		async (source) => browser.storage.session.set({ "upload:popup": source }),
		{ srcUrl },
	);
	await page.addInitScript(() => {
		window.close = () => {
			window.uploadClosed = true;
		};
	});
	let uploads = 0;
	await page.route("**/api/media", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		if (++uploads === 1)
			return route.fulfill({ status: 503, body: "Temporary failure" });
		return route.continue();
	});
	await page.goto(
		`${app.web.origin}/client/dist/extension/upload.html?id=popup`,
	);
	await expect(page.locator("#preview")).toBeVisible();
	await page.locator("#tags").fill("vacation");
	await page.locator("#send button").click();
	await expect(page.locator("#status")).toHaveText("Temporary failure");
	expect((await storage(page)).session["upload:popup"]).toBeTruthy();
	await page.locator("#send button").click();
	await expect(page.locator("#status")).toHaveText("Uploaded.");
	expect((await storage(page)).session["upload:popup"]).toBeUndefined();
	expect(await page.evaluate(() => window.uploadClosed)).toBe(true);
	expect(uploads).toBe(2);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(page.locator(".card strong")).toHaveText("remote.png");
	await expect(page.locator(".tag-text")).toHaveText("vacation");
});

test("unlock popup resumes only its own queued upload", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const srcUrl = `${app.web.origin}/remote.png`;
	await page.route("**/remote.png", (route) =>
		route.fulfill({ contentType: "image/png", body: png }),
	);
	await page.evaluate(
		async (source) => {
			await browser.storage.session.clear();
			await browser.storage.session.set({
				"upload:first": source,
				"upload:second": {
					...source,
					srcUrl: "https://other.example/image.png",
				},
			});
		},
		{ srcUrl },
	);
	await page.addInitScript(() => {
		window.close = () => {
			window.uploadClosed = true;
		};
	});
	await page.goto(
		`${app.web.origin}/client/dist/extension/unlock.html?id=first`,
	);
	await page.locator("#pass").fill(PASSWORD);
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#status")).toHaveText("Uploaded.");
	const saved = await storage(page);
	expect(saved.session["upload:first"]).toBeUndefined();
	expect(saved.session["upload:second"]).toBeTruthy();
	expect(await page.evaluate(() => window.uploadClosed)).toBe(true);
});

test("a locked tags popup waits for tags after unlocking", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const srcUrl = `${app.web.origin}/remote.png`;
	await page.route("**/remote.png", (route) =>
		route.fulfill({ contentType: "image/png", body: png }),
	);
	await page.evaluate(
		async (source) => {
			await browser.storage.session.clear();
			await browser.storage.session.set({ "upload:tags": source });
		},
		{ srcUrl },
	);
	await page.addInitScript(() => {
		window.close = () => {};
	});
	let posts = 0;
	page.on("request", (request) => {
		if (request.method() === "POST" && request.url().endsWith("/api/media"))
			posts++;
	});
	await page.goto(
		`${app.web.origin}/client/dist/extension/upload.html?id=tags`,
	);
	await page.locator("#pass").fill(PASSWORD);
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#send #tags")).toBeVisible();
	expect(posts).toBe(0);
	await page.locator("#tags").fill("chosen-tag");
	await page.locator("#send button").click();
	await expect(page.locator("#status")).toHaveText("Uploaded.");
	expect(posts).toBe(1);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await expect(page.locator(".tag-text")).toHaveText("chosen-tag");
});
