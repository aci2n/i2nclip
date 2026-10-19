import { readFile } from "node:fs/promises";
import { upload } from "../src/lib/api.ts";
import { openRecovery } from "../src/lib/protocol/recovery.ts";
import { assertPresent } from "../tests/assert.ts";
import {
	audioFixture,
	createLibrary,
	expect,
	imageFixture,
	PASSWORD,
	recovery,
	test,
} from "./fixtures.ts";

test("native players stop on preview navigation and close", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		audioFixture(),
		{
			name: "Video.webm",
			mimeType: "video/webm",
			buffer: await readFile(new URL("./fixtures/clip.webm", import.meta.url)),
		},
	]);
	await expect(page.getByRole("article")).toHaveCount(2);
	// Uploads can share a timestamp; their ID tie-breaker decides the order.
	const videoFirst = await page
		.getByRole("article")
		.first()
		.getByRole("button", { name: "Play Video.webm", exact: true })
		.count();
	const direction = videoFirst ? "Next media" : "Previous media";
	await page
		.getByRole("button", { name: "Play Video.webm", exact: true })
		.click();
	const video = await page.locator("dialog video").evaluateHandle((element) => {
		if (!(element instanceof HTMLVideoElement)) {
			throw new Error("Expected video player");
		}
		return element;
	});
	try {
		await assertPresent(video).evaluate(async (player) => {
			player.loop = true;
			await player.play();
		});
		await expect
			.poll(() =>
				assertPresent(video).evaluate(
					(player) => !player.paused && player.currentTime > 0,
				),
			)
			.toBe(true);
		await page.getByRole("button", { name: direction, exact: true }).focus();
		await page.keyboard.press(videoFirst ? "ArrowRight" : "ArrowLeft");
		await expect(page.locator("dialog audio")).toBeVisible();
		await expect
			.poll(() => assertPresent(video).evaluate((player) => player.paused))
			.toBe(true);
		const audio = await page
			.locator("dialog audio")
			.evaluateHandle((element) => {
				if (!(element instanceof HTMLAudioElement)) {
					throw new Error("Expected audio player");
				}
				return element;
			});
		try {
			await assertPresent(audio).evaluate(async (player) => {
				player.loop = true;
				await player.play();
			});
			await expect
				.poll(() =>
					assertPresent(audio).evaluate(
						(player) => !player.paused && player.currentTime > 0,
					),
				)
				.toBe(true);
			await page
				.getByRole("button", { name: "Close preview", exact: true })
				.click();
			await expect(
				page.getByRole("dialog", { name: "Media preview" }),
			).not.toBeVisible();
			await expect
				.poll(() => assertPresent(audio).evaluate((player) => player.paused))
				.toBe(true);
		} finally {
			await assertPresent(audio).dispose();
		}
	} finally {
		await assertPresent(video).dispose();
	}
});
test("preview stops at loaded boundaries and More loads the submitted search", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const manifest = await recovery(page);
	const { identity, key } = await openRecovery(manifest, PASSWORD);
	const image = await imageFixture(page, "Landscape.png", 960, 540);
	for (let index = 0; index < 25; index++) {
		await upload({
			serverUrl: identity.server_url,
			key,
			file: new Blob([image.buffer]),
			name: `Landscape ${index}.png`,
			contentType: image.mimeType,
			tags: ["Gallery"],
		});
	}
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const search = page.getByRole("searchbox");
	await search.fill("Gallery");
	const submitted = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return url.pathname === "/api/media" && url.searchParams.has("tag");
	});
	await search.press("Enter");
	const submittedUrl = new URL((await submitted).url());
	await expect(page.getByRole("article")).toHaveCount(24);
	await expect(
		page.getByRole("button", { name: "More", exact: true }),
	).toBeEnabled();
	await search.fill("Unsubmitted draft");
	const requests: Array<URL> = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (request.method() === "GET" && url.pathname === "/api/media") {
			requests.push(url);
		}
	});
	const opener = page
		.getByRole("article")
		.last()
		.getByRole("button", { name: /^Open / });
	const name = assertPresent(await opener.getAttribute("aria-label")).slice(5);
	await opener.click();
	const dialog = page.getByRole("dialog", { name: "Media preview" });
	await expect(dialog.getByRole("img", { name, exact: true })).toBeVisible();
	await expect(dialog.getByRole("status")).toHaveCount(0);
	const next = dialog.getByRole("button", { name: "Next media", exact: true });
	await expect(next).toBeDisabled();
	await page.keyboard.press("ArrowRight");
	await expect(dialog.getByRole("img", { name, exact: true })).toBeVisible();
	for (const width of [1100, 360]) {
		await page.setViewportSize({ width, height: 760 });
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			await page.screenshot({
				path: test
					.info()
					.outputPath(`preview-boundary-${width}-${colorScheme}.png`),
			});
		}
	}
	await dialog
		.getByRole("button", { name: "Close preview", exact: true })
		.click();
	await expect(opener).toBeFocused();
	expect(requests).toHaveLength(0);
	await page.getByRole("button", { name: "More", exact: true }).click();
	await expect(page.getByRole("article")).toHaveCount(25);
	expect(requests).toHaveLength(1);
	expect(requests[0].searchParams.get("tag")).toBe(
		submittedUrl.searchParams.get("tag"),
	);
	expect(requests[0].searchParams.has("after")).toBe(true);
	await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
	await expect(next).toBeEnabled();
	await page.keyboard.press("ArrowRight");
	await expect(dialog.getByRole("status")).toHaveCount(0);
	await expect(dialog.getByRole("img")).toBeVisible();
	await expect(dialog.getByRole("img", { name, exact: true })).toHaveCount(0);
	await expect(next).toBeDisabled();
	expect(requests).toHaveLength(1);
});
