import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import {
	database,
	issueOtc,
	startServer,
	stopServer,
} from "../tests/process.ts";
export const PASSWORD = "test-pass-1";
export { issueOtc };
export interface App {
	data: string;
	origin: string;
}
export const test = base.extend<{
	app: App;
}>({
	app: async ({ page }, use) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const data = await database("create");
		let api: Awaited<ReturnType<typeof startServer>> | undefined;
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
export async function master(page: Page, remember = false) {
	await page.getByLabel("Master password", { exact: true }).fill(PASSWORD);
	if (remember) {
		await page.getByRole("checkbox", { name: "Remember this device" }).check();
	}
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
interface RecoveryArtifact {
	bytes: Buffer<ArrayBuffer>;
	password: string;
}
const recoveryArtifacts = new WeakMap<Page, RecoveryArtifact>();
const recoveryPasswords = new WeakMap<Buffer, string>();
export async function createLibrary(
	page: Page,
	app: App,
	maxBytes?: number,
	remember = false,
) {
	await page.goto(`${app.origin}/#/settings`);
	await master(page, remember);
	await page
		.getByRole("button", { name: "Prepare library", exact: true })
		.click();
	const password = await page
		.getByLabel("Recovery password", { exact: true })
		.inputValue();
	expect(password).toHaveLength(43);
	await expect(
		page.getByRole("button", { name: "Create library", exact: true }),
	).toBeDisabled();
	const downloading = page.waitForEvent("download");
	await page
		.getByRole("button", { name: "Download recovery file", exact: true })
		.click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("i2nclip-library-recovery.msgpack");
	const bytes = Buffer.from(await readFile(await download.path()));
	recoveryArtifacts.set(page, { bytes, password });
	recoveryPasswords.set(bytes, password);
	await page
		.getByLabel("Invitation code", { exact: true })
		.fill(await issueOtc(app.data, "debug", maxBytes));
	await page
		.getByRole("button", { name: "Create library", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Your library", exact: true }),
	).toBeVisible();
}
export async function recovery(page: Page) {
	const artifact = recoveryArtifacts.get(page);
	if (!artifact) {
		throw new Error("This test has no saved recovery file.");
	}
	return artifact.bytes;
}
export function recoveryPassword(bytes: Buffer) {
	const password = recoveryPasswords.get(bytes);
	if (!password) {
		throw new Error("Recovery password is not owned by this test.");
	}
	return password;
}
export async function restore(page: Page, app: App, bytes: Buffer) {
	await page.goto(`${app.origin}/#/settings`);
	await master(page);
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await page.getByLabel("Recovery file", { exact: true }).setInputFiles({
		name: "recovery.msgpack",
		mimeType: "application/msgpack",
		buffer: bytes,
	});
	await page
		.getByLabel("Recovery password", { exact: true })
		.fill(recoveryPassword(bytes));
	await page
		.getByRole("button", { name: "Restore library", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Submit recovery reset", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Submit recovery reset", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Your library", exact: true }),
	).toBeVisible();
}
export async function imageFixture(
	page: Page,
	name: string,
	width: number,
	height: number,
) {
	const bytes = await page.evaluate(
		({ width, height }) => {
			function assertPresent<T>(value: T | null | undefined): T {
				if (value === null || value === undefined) {
					throw new Error("Required test value is missing.");
				}
				return value;
			}
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = assertPresent(canvas.getContext("2d"));
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
export async function shot(page: Page, name: string, { fullPage = true } = {}) {
	const directory = base.info().outputPath("screenshots");
	await mkdir(directory, { recursive: true });
	for (const theme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: theme });
		await page.screenshot({
			path: path.join(directory, `${name}-${theme}.png`),
			fullPage,
		});
	}
	await page.emulateMedia({ colorScheme: "light" });
}

export async function openUploadPreferences(page: Page) {
	const section = page
		.locator(".settings > details")
		.filter({ has: page.locator("summary").filter({ hasText: /^Uploads$/ }) });
	if (
		!(await section.evaluate(
			(node) => node instanceof HTMLDetailsElement && node.open,
		))
	) {
		await section.locator("summary").first().click();
	}
	await expect(
		page.getByRole("checkbox", {
			name: "Compress images to WebP",
			exact: true,
		}),
	).toBeVisible();
}
