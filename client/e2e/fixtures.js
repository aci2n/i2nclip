import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import {
	database,
	issueOtc,
	startServer,
	stopServer,
} from "../tests/process.js";

export const PASSWORD = "test-pass-1";
export { issueOtc };

export const test = base.extend({
	app: async ({ page }, use) => {
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const data = await database("create");
		let api;
		try {
			api = await startServer(data);
			await use({ data, origin: api.origin });
			expect(errors).toEqual([]);
		} finally {
			await stopServer(api?.child);
			await database("drop", data);
		}
	},
});
export { expect };
export async function master(page) {
	await page.getByLabel("Master password", { exact: true }).fill(PASSWORD);
	const confirmation = page.getByLabel("Confirm master password", {
		exact: true,
	});
	if (await confirmation.isVisible()) {
		await confirmation.fill(PASSWORD);
		await page
			.getByRole("button", { name: "Create master password", exact: true })
			.click();
	} else {
		await page.getByRole("button", { name: "Unlock", exact: true }).click();
	}
	await expect(
		page.getByRole("navigation", { name: "Main navigation" }),
	).toBeVisible();
}
export async function createLibrary(page, app) {
	await page.goto(`${app.origin}/?page=settings`);
	await master(page);
	await expect(page.getByLabel("Library name", { exact: true })).toHaveCount(0);
	await page
		.getByLabel("Invitation code", { exact: true })
		.fill(await issueOtc(app.data));
	await page
		.getByRole("button", { name: "Create library", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Your library", exact: true }),
	).toBeVisible();
}
export async function recovery(page) {
	await page
		.getByText("Download recovery file", { exact: true })
		.first()
		.click();
	await page.getByLabel("Recovery password", { exact: true }).fill(PASSWORD);
	await page
		.getByLabel("Confirm recovery password", { exact: true })
		.fill(PASSWORD);
	const downloading = page.waitForEvent("download");
	await page
		.getByRole("button", { name: "Download recovery file", exact: true })
		.click();
	return readFile(await (await downloading).path());
}
export async function restore(page, app, bytes) {
	await page.goto(`${app.origin}/?page=settings`);
	await master(page);
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await page.getByLabel("Recovery file", { exact: true }).setInputFiles({
		name: "recovery.msgpack",
		mimeType: "application/msgpack",
		buffer: bytes,
	});
	await page.getByLabel("Recovery password", { exact: true }).fill(PASSWORD);
	await page
		.getByRole("button", { name: "Restore library", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Your library", exact: true }),
	).toBeVisible();
}
export async function imageFixture(page, name, width, height) {
	const bytes = await page.evaluate(
		({ width, height }) => {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#397e78";
			ctx.fillRect(0, 0, width, height);
			ctx.fillStyle = "#dfbf83";
			ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
			return Array.from(
				atob(canvas.toDataURL("image/png").split(",")[1]),
				(value) => value.charCodeAt(0),
			);
		},
		{ width, height },
	);
	return { name, mimeType: "image/png", buffer: Buffer.from(bytes) };
}
export function audioFixture() {
	const samples = 8000;
	const wav = Buffer.alloc(44 + samples * 2);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(samples, 24);
	wav.writeUInt32LE(samples * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(samples * 2, 40);
	return { name: "Voice memo.wav", mimeType: "audio/wav", buffer: wav };
}
export async function shot(page, name, { fullPage = true } = {}) {
	const directory = base.info().outputPath("screenshots");
	await mkdir(directory, { recursive: true });
	for (const theme of ["light", "dark"]) {
		await page.emulateMedia({ colorScheme: theme });
		await page.screenshot({
			path: path.join(directory, `${name}-${theme}.png`),
			fullPage,
		});
	}
	await page.emulateMedia({ colorScheme: "light" });
}
