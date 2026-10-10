import {
	createLibrary,
	expect,
	PASSWORD,
	png,
	storage,
	test,
} from "./fixtures.js";

test("a failed immediate context-menu upload opens an explicit retry popup", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const srcUrl = `${app.web.origin}/remote.png`;
	await page.route("**/remote.png", (route) =>
		route.fulfill({ contentType: "image/png", body: png }),
	);
	let uploads = 0;
	await page.route("**/api/media", (route) => {
		if (route.request().method() !== "POST") return route.continue();
		if (++uploads === 1)
			return route.fulfill({ status: 503, body: "Temporary failure" });
		return route.continue();
	});
	const popup = await page.evaluate(async (srcUrl) => {
		browser.contextMenus = {
			removeAll: async () => {},
			create() {},
			onClicked: {
				addListener(handler) {
					window.contextUpload = handler;
				},
			},
		};
		browser.action = { onClicked: { addListener() {} } };
		browser.windows = {
			create: async (options) => {
				window.contextPopup = options;
			},
		};
		await import(new URL("background.js", location.href).href);
		await window.contextUpload({ menuItemId: "upload", srcUrl }, { id: 7 });
		return window.contextPopup;
	}, srcUrl);
	const id = new URL(popup.url).searchParams.get("id");
	expect(popup.type).toBe("popup");
	expect(new URL(popup.url).pathname).toContain("upload.html");
	expect((await storage(page)).session[`upload:${id}`].error).toBe(
		"Temporary failure",
	);
	await page.addInitScript(() => {
		window.close = () => {
			window.uploadClosed = true;
		};
	});
	await page.goto(popup.url);
	await expect(page.locator("#status")).toHaveText("Temporary failure");
	await expect(page.locator("#send button")).toBeEnabled();
	expect(uploads).toBe(1);
	await page.locator("#send button").click();
	await expect(page.locator("#status")).toHaveText("Uploaded.");
	expect(uploads).toBe(2);
	expect((await storage(page)).session[`upload:${id}`]).toBeUndefined();
	expect(await page.evaluate(() => window.uploadClosed)).toBe(true);
});

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

test("preparation and transfer failures retry in the same popup and preserve tag drafts", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await expect(
		page
			.getByRole("navigation")
			.getByRole("link", { name: "Upload", exact: true }),
	).toHaveCount(0);
	const srcUrl =
		"https://media.example/landscape-with-a-long-descriptive-file-name.svg";
	let reads = 0,
		uploads = 0;
	await page.route(srcUrl, async (route) => {
		reads++;
		if (reads === 1) return route.fulfill({ status: 503, body: "offline" });
		await route.fulfill({
			contentType: "image/svg+xml",
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#328878"/><circle cx="480" cy="270" r="160" fill="#dcebbd"/></svg>',
		});
	});
	await page.route("**/api/media", async (route) => {
		if (route.request().method() === "POST" && ++uploads === 1)
			return route.fulfill({
				status: 503,
				body: '{"error":"temporary transfer failure"}',
			});
		await route.continue();
	});
	await page.evaluate(async (srcUrl) => {
		await browser.storage.session.set({
			"upload:preparation-retry": { id: "preparation-retry", srcUrl },
		});
	}, srcUrl);
	await page.goto(
		`${app.web.origin}/client/dist/extension/upload.html?id=preparation-retry`,
	);
	await expect(page.locator("#status")).toContainText(
		"Could not fetch the file (503)",
	);
	const button = page.locator('#send button[type="submit"]');
	await expect(button).toBeEnabled();
	await page.locator("#tags").fill("landscape, retry draft");
	await button.click();
	await expect(page.locator("#status")).toContainText(
		"temporary transfer failure",
	);
	await expect(page.locator("#tags")).toHaveValue("landscape, retry draft");
	const preview = await page.locator("#preview").getAttribute("src");
	for (const destination of ["Settings", "Library"]) {
		await page
			.getByRole("navigation")
			.getByRole("link", { name: destination, exact: true })
			.click();
		await expect(
			page
				.getByRole("navigation")
				.getByRole("link", { name: "Upload", exact: true }),
		).toBeVisible();
		await page
			.getByRole("navigation")
			.getByRole("link", { name: "Upload", exact: true })
			.click();
		await expect(page.locator("#tags")).toHaveValue("landscape, retry draft");
		await expect(page.locator("#status")).toContainText(
			"temporary transfer failure",
		);
		await expect(page.locator("#preview")).toHaveAttribute("src", preview);
	}
	await page.goBack();
	await expect(
		page.getByRole("link", { name: "Library", exact: true }),
	).toHaveAttribute("aria-current", "page");
	await page.goForward();
	await expect(page.locator("#tags")).toHaveValue("landscape, retry draft");
	expect(reads).toBe(2);
	expect(uploads).toBe(1);
	expect(
		(await storage(page)).session["upload:preparation-retry"],
	).toBeTruthy();
	for (const theme of ["light", "dark"]) {
		await page.emulateMedia({ colorScheme: theme });
		for (const width of [320, 360]) {
			await page.setViewportSize({ width, height: 800 });
			await page.screenshot({
				path: `e2e/shots/preparation-retry-${width}-${theme}.png`,
				fullPage: true,
			});
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
		}
	}
	await page.waitForTimeout(100);
	expect(uploads).toBe(1);
	await button.click();
	await expect(page.locator("#status")).toHaveText("Uploaded.");
	await expect
		.poll(async () => (await storage(page)).session["upload:preparation-retry"])
		.toBeUndefined();
	expect(reads).toBe(2);
	expect(uploads).toBe(2);
});
