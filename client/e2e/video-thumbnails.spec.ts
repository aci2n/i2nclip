import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { root } from "../tests/process.ts";
import { createLibrary, expect, master, shot, test } from "./fixtures.ts";

// Valid container padding makes large, seekable files without large fixture
// binaries or a runtime FFmpeg dependency. The MP4 index remains at the tail.
async function largeVideo(directory: string, format: "mp4" | "webm") {
	const original = await readFile(
		new URL(`./fixtures/clip.${format}`, import.meta.url),
	);
	const padding = 64 * 1024 * 1024;
	const filename = path.join(directory, `Large.${format}`);
	const file = await open(filename, "w");
	try {
		if (format === "mp4") {
			let offset = 0;
			while (
				offset < original.length &&
				original.toString("ascii", offset + 4, offset + 8) !== "moov"
			) {
				const length = original.readUInt32BE(offset);
				if (length < 8) {
					throw new Error("Invalid MP4 fixture box.");
				}
				offset += length;
			}
			expect(offset).toBeLessThan(original.length);
			const free = Buffer.alloc(8);
			free.writeUInt32BE(padding);
			free.write("free", 4, "ascii");
			await file.writeFile(original.subarray(0, offset));
			await file.writeFile(free);
			await file.write(
				original.subarray(offset),
				0,
				original.length - offset,
				offset + padding,
			);
		} else {
			const segment = original.indexOf(Buffer.from("18538067", "hex"));
			expect(segment).toBeGreaterThanOrEqual(0);
			// The checked-in clip uses an eight-byte Segment size. Extend it to
			// include an EBML Void without changing any existing sample offsets.
			expect(original[segment + 4]).toBe(1);
			original.writeBigUInt64BE(
				original.readBigUInt64BE(segment + 4) + BigInt(padding),
				segment + 4,
			);
			const empty = Buffer.alloc(9);
			empty[0] = 0xec;
			empty.writeBigUInt64BE((1n << 56n) | BigInt(padding - empty.length), 1);
			await file.writeFile(original);
			await file.writeFile(empty);
			await file.truncate(original.length + padding);
		}
	} finally {
		await file.close();
	}
	return filename;
}

test("large MP4 and WebM uploads retain first-frame thumbnails after reload", async ({
	page,
	app,
}) => {
	await mkdir(path.join(root, "client/dist"), { recursive: true });
	const directory = await mkdtemp(
		path.join(root, "client/dist/video-thumbnails-"),
	);
	try {
		const files = [
			await largeVideo(directory, "mp4"),
			await largeVideo(directory, "webm"),
		];
		await createLibrary(page, app);
		await page.getByRole("link", { name: "Library", exact: true }).click();
		await page.getByLabel("Upload", { exact: true }).setInputFiles(files);
		await expect(page.getByRole("article")).toHaveCount(2, { timeout: 90_000 });
		await expect(
			page.getByText(/thumbnail preparation are skipped/),
		).toHaveCount(0);
		// Reload verifies that list metadata carries the encrypted thumbnails,
		// independently of the temporary native video elements used to make them.
		await page.reload();
		await master(page);
		await page.getByRole("link", { name: "Library", exact: true }).click();
		for (const format of ["mp4", "webm"]) {
			const card = page
				.getByRole("article")
				.filter({ hasText: `Large.${format}` });
			const image = card.getByRole("img", {
				name: `Large.${format}`,
				exact: true,
			});
			await expect(image).toBeVisible();
			await expect
				.poll(() =>
					image.evaluate(
						(element: HTMLImageElement) =>
							element.complete &&
							element.naturalWidth > 1 &&
							element.naturalWidth <= 320 &&
							element.naturalHeight > 1 &&
							element.naturalHeight <= 320,
					),
				)
				.toBe(true);
			await card.getByText("File details", { exact: true }).click();
			await expect(
				card.getByText(`video/${format}`, { exact: true }),
			).toBeVisible();
		}
		for (const width of [1100, 320, 360]) {
			await page.setViewportSize({ width, height: 800 });
			await shot(page, `large-video-thumbnails-${width}`);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
