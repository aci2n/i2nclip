import { readFile } from "node:fs/promises";
import { audioFixture, createLibrary, expect, test } from "./fixtures.js";

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
	const video = await page.locator("dialog video").elementHandle();
	try {
		await video.evaluate(async (player) => {
			player.loop = true;
			await player.play();
		});
		await expect
			.poll(() =>
				video.evaluate((player) => !player.paused && player.currentTime > 0),
			)
			.toBe(true);
		await page.getByRole("button", { name: direction, exact: true }).focus();
		await page.keyboard.press(videoFirst ? "ArrowRight" : "ArrowLeft");
		await expect(page.locator("dialog audio")).toBeVisible();
		await expect
			.poll(() => video.evaluate((player) => player.paused))
			.toBe(true);
		const audio = await page.locator("dialog audio").elementHandle();
		try {
			await audio.evaluate(async (player) => {
				player.loop = true;
				await player.play();
			});
			await expect
				.poll(() =>
					audio.evaluate((player) => !player.paused && player.currentTime > 0),
				)
				.toBe(true);
			await page
				.getByRole("button", { name: "Close preview", exact: true })
				.click();
			await expect(
				page.getByRole("dialog", { name: "Media preview" }),
			).not.toBeVisible();
			await expect
				.poll(() => audio.evaluate((player) => player.paused))
				.toBe(true);
		} finally {
			await audio.dispose();
		}
	} finally {
		await video.dispose();
	}
});
