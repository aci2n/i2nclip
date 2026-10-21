import { readFile } from "node:fs/promises";
import { assertPresent } from "../tests/assert.ts";
import {
	audioFixture,
	createLibrary,
	expect,
	imageFixture,
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
		.getByRole("button", { name: "Open Video.webm", exact: true })
		.count();
	const direction = videoFirst ? "Next media" : "Previous media";
	await page
		.getByRole("button", { name: "Open Video.webm", exact: true })
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
	const image = await imageFixture(page, "Gallery.png", 960, 540);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await page.getByLabel("Upload", { exact: true }).setInputFiles(
		Array.from({ length: 41 }, (_, index) => ({
			...image,
			name: `Gallery ${index}.png`,
		})),
	);
	await expect(page.getByLabel("Block", { exact: true })).toHaveValue("41");
	const search = page.getByRole("searchbox", {
		name: "Search files",
		exact: true,
	});
	await search.fill("Gallery");
	await search.press("Enter");
	await expect(page.getByRole("article")).toHaveCount(40);
	await search.fill("Unsubmitted draft");
	await page.getByRole("button", { name: "More", exact: true }).click();
	await expect(page.getByRole("article")).toHaveCount(41);
	const opener = page
		.getByRole("article")
		.last()
		.getByRole("button", { name: /^Open / });
	await opener.click();
	await expect(
		page
			.getByRole("dialog")
			.getByRole("button", { name: "Next media", exact: true }),
	).toBeDisabled();
});

test("tail-indexed MP4 reads its final encrypted chunk and seeks through the native player", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const original = await readFile(
		new URL("./fixtures/clip.mp4", import.meta.url),
	);
	let offset = 0;
	while (
		offset < original.length &&
		original.toString("ascii", offset + 4, offset + 8) !== "moov"
	) {
		offset += original.readUInt32BE(offset);
	}
	expect(offset).toBeLessThan(original.length);
	const padding = Buffer.alloc(8 * 1024 * 1024);
	padding.writeUInt32BE(padding.length);
	padding.write("free", 4, "ascii");
	// A free box after mdat preserves sample offsets and moves moov past 8 MiB.
	const buffer = Buffer.concat([
		original.subarray(0, offset),
		padding,
		original.subarray(offset),
	]);
	await page
		.getByLabel("Upload", { exact: true })
		.setInputFiles({ name: "Tail.mp4", mimeType: "video/mp4", buffer });
	await expect(page.getByRole("article")).toHaveCount(1);
	const chunks = new Set<string>();
	page.on("request", (request) => {
		if (request.method() === "GET") {
			const match = new URL(request.url()).pathname.match(
				/\/api\/blobs\/[a-f0-9]{64}\/([a-f0-9]{64})$/,
			);
			if (match) {
				chunks.add(match[1]);
			}
		}
	});
	await page
		.getByRole("button", { name: "Open Tail.mp4", exact: true })
		.click();
	const video = page.getByRole("dialog").locator("video");
	await expect
		.poll(() =>
			video.evaluate((element: HTMLVideoElement) => element.readyState),
		)
		.toBeGreaterThanOrEqual(1);
	await video.evaluate(async (element: HTMLVideoElement) => {
		element.currentTime = 1;
		await element.play();
	});
	await expect
		.poll(() =>
			video.evaluate((element: HTMLVideoElement) => element.currentTime),
		)
		.toBeGreaterThan(1);
	expect(chunks.size).toBeGreaterThanOrEqual(3);
	await page
		.getByRole("button", { name: "Close preview", exact: true })
		.click();
});
