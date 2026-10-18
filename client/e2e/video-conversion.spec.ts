import { readFile } from "node:fs/promises";
import { BlobSource, Input, WEBM } from "mediabunny";
import {
	audioFixture,
	createLibrary,
	expect,
	imageFixture,
	master,
	shot,
	test,
} from "./fixtures.ts";

test("video options preserve per-file snapshots across navigation and persist device defaults", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const enabled = page.getByRole("checkbox", {
		name: "Convert video",
		exact: true,
	});
	await expect(enabled).not.toBeChecked();
	await enabled.check();
	await page
		.getByRole("combobox", { name: "Video container", exact: true })
		.selectOption("webm");
	await expect(
		page.getByRole("combobox", { name: "Video codec", exact: true }),
	).toHaveValue("vp9");
	await page
		.getByLabel("Maximum video width (px)", { exact: true })
		.fill("320");
	await page.getByRole("heading", { name: "Videos", exact: true }).click();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const buffer = await readFile(
		new URL("./fixtures/clip.webm", import.meta.url),
	);
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		{
			name: "Landscape video with a long filename.webm",
			mimeType: "video/webm",
			buffer,
		},
		{ name: "Second video.webm", mimeType: "video/webm", buffer },
		await imageFixture(page, "Portrait.png", 360, 640),
		audioFixture(),
	]);
	const review = page.getByRole("region", { name: "Review uploads" });
	const first = review.getByRole("article").nth(0);
	const second = review.getByRole("article").nth(1);
	await first.getByText("Upload options", { exact: true }).click();
	await first
		.getByRole("combobox", { name: "Video container", exact: true })
		.selectOption("mp4");
	await expect(
		first.getByRole("combobox", { name: "Video codec", exact: true }),
	).toHaveValue("avc");
	await first
		.getByRole("combobox", { name: "Video quality", exact: true })
		.selectOption("low");
	await second.getByText("Upload options", { exact: true }).click();
	await expect(
		second.getByRole("combobox", { name: "Video container", exact: true }),
	).toHaveValue("webm");
	for (const width of [1100, 320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
			await shot(page, `video-options-${width}-${colorScheme}`);
		}
	}
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Videos", exact: true }),
	).toBeVisible();
	await page
		.getByLabel("Maximum video width (px)", { exact: true })
		.fill("240");
	await page.getByRole("heading", { name: "Videos", exact: true }).click();
	await page.getByRole("link", { name: "Library", exact: true }).click();
	await second.getByText("Upload options", { exact: true }).click();
	await expect(
		second.getByLabel("Maximum video width (px)", { exact: true }),
	).toHaveValue("320");
	await second
		.getByRole("button", { name: "Use defaults", exact: true })
		.click();
	await expect(
		second.getByLabel("Maximum video width (px)", { exact: true }),
	).toHaveValue("240");
	await first.getByText("Upload options", { exact: true }).click();
	await expect(
		first.getByRole("combobox", { name: "Video container", exact: true }),
	).toHaveValue("mp4");
	await review.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.reload();
	await master(page);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Videos", exact: true }),
	).toBeVisible();
	await expect(enabled).toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Video container", exact: true }),
	).toHaveValue("webm");
	await expect(
		page.getByLabel("Maximum video width (px)", { exact: true }),
	).toHaveValue("240");
});

test("native video conversion saves smaller resized output or explains missing browser codecs", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const source = await readFile(
		new URL("./fixtures/clip.webm", import.meta.url),
	);
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		{ name: "Converted clip.webm", mimeType: "video/webm", buffer: source },
		{
			name: "Following.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("The batch continues."),
		},
	]);
	const review = page.getByRole("region", { name: "Review uploads" });
	await review.getByText("Upload options", { exact: true }).click();
	await review
		.getByRole("checkbox", { name: "Convert video", exact: true })
		.check();
	await review
		.getByRole("combobox", { name: "Video container", exact: true })
		.selectOption("webm");
	await review
		.getByRole("combobox", { name: "Video codec", exact: true })
		.selectOption("vp8");
	await review
		.getByRole("combobox", { name: "Video quality", exact: true })
		.selectOption("very-low");
	await review
		.getByLabel("Maximum video width (px)", { exact: true })
		.fill("240");
	await review
		.getByLabel("Maximum frame rate (fps)", { exact: true })
		.fill("5");
	await review
		.getByRole("button", { name: "Start upload", exact: true })
		.click();
	const card = page.getByRole("article").filter({
		has: page.getByRole("button", {
			name: "Play Converted clip.webm",
			exact: true,
		}),
	});
	await expect(card).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Open Following.txt", exact: true }),
	).toBeVisible();
	const saving = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	const result = await readFile(await (await saving).path());
	const supported = await page.evaluate(async () => {
		if (
			typeof VideoEncoder === "undefined" ||
			typeof VideoDecoder === "undefined"
		) {
			return false;
		}
		return (
			(
				await VideoEncoder.isConfigSupported({
					codec: "vp8",
					width: 240,
					height: 134,
					bitrate: 100000,
					framerate: 5,
				})
			).supported &&
			(await VideoDecoder.isConfigSupported({ codec: "vp8" })).supported
		);
	});
	if (supported) {
		expect(result.length).toBeLessThan(source.length);
		const input = new Input({
			source: new BlobSource(new Blob([result])),
			formats: [WEBM],
		});
		try {
			const tracks = await input.getVideoTracks();
			expect(tracks).toHaveLength(1);
			expect(await tracks[0].getDisplayWidth()).toBe(240);
			expect(await tracks[0].getDisplayHeight()).toBe(134);
			expect(
				(await tracks[0].computePacketStats()).averagePacketRate,
			).toBeLessThanOrEqual(5.1);
		} finally {
			input.dispose();
		}
	} else {
		expect(result).toEqual(source);
		await expect(
			page.getByRole("region", { name: "Uploads", exact: true }),
		).toContainText("Using original:");
	}
});

test("invalid video conversion retains original bytes and continues the mixed batch", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const bytes = Buffer.from([0, 1, 2, 3, 4]);
	await page.getByLabel("Upload", { exact: true }).setInputFiles([
		{ name: "Broken.mp4", mimeType: "video/mp4", buffer: bytes },
		{
			name: "Following.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Still uploaded"),
		},
	]);
	const review = page.getByRole("region", { name: "Review uploads" });
	await review.getByText("Upload options", { exact: true }).click();
	await review
		.getByRole("checkbox", { name: "Convert video", exact: true })
		.check();
	await review
		.getByRole("button", { name: "Start upload", exact: true })
		.click();
	await expect(
		page.getByRole("region", { name: "Uploads", exact: true }),
	).toContainText("Using original:");
	await expect(
		page.getByRole("button", { name: "Open Following.txt", exact: true }),
	).toBeVisible();
	const card = page.getByRole("article").filter({
		has: page.getByRole("button", { name: "Play Broken.mp4", exact: true }),
	});
	const saving = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	expect(await readFile(await (await saving).path())).toEqual(bytes);
});
