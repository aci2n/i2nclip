import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { test as base, expect } from "@playwright/test";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const test = base.extend({
	app: async ({ page }, use) => {
		const data = await mkdtemp(path.join(tmpdir(), "i2nclip-e2e-"));
		const apiPort = await freePort();
		const origin = `http://127.0.0.1:${apiPort}`;
		const api = await startApi(data, origin, `127.0.0.1:${apiPort}`);
		const web = await startWeb();
		await page.context().addInitScript(installBrowser);
		try {
			await use({ data, origin, web });
		} finally {
			web.close();
			api.kill();
			await rm(data, { recursive: true, force: true });
		}
	},
});

const PASSWORD = "test-pass-1";
const DEFAULT_SERVER = "https://clip.i2n.duckdns.org";

async function options(page, app) {
	await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
	await openServer(page);
	await page.locator("#server").fill(app.origin);
}

async function fillCreation(page, code) {
	await page.locator("#otc").fill(code);
	await page.locator("#pass").fill(PASSWORD);
}

async function storage(page) {
	return page.evaluate(async () => ({
		local: await browser.storage.local.get(null),
		session: await browser.storage.session.get(null),
	}));
}

async function expectSetup(page) {
	await expect(
		page.getByRole("tab", { name: "Create", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("tab", { name: "Restore", exact: true }),
	).toBeVisible();
	await expect(page.locator("#configured")).toBeHidden();
	await expect(page.locator("#reset-settings")).toBeHidden();
}

async function openServer(page) {
	const details = page.locator("#server-details");
	if (!(await details.evaluate((element) => element.open)))
		await details.locator("summary").click();
}

async function openReset(page) {
	const details = page.locator("#reset-settings");
	if (!(await details.evaluate((element) => element.open)))
		await details.locator("summary").click();
}

async function chooseRestore(page) {
	await page.getByRole("tab", { name: "Restore", exact: true }).click();
	await expect(page.locator("#restore-settings")).toBeVisible();
	await expect(page.locator("#create")).toBeHidden();
}

async function expectConfigured(page) {
	await expect(page.locator("#create")).toBeHidden();
	await expect(page.locator("#restore-settings")).toBeHidden();
	await expect(page.locator("#configured")).toBeVisible();
	await expect(page.locator("#reset-settings")).toBeVisible();
	await expect(page.locator("#registration")).toHaveCount(0);
}

async function createLibrary(page, app) {
	await options(page, app);
	const code = await issueOtc(app.data);
	await fillCreation(page, code);
	await page.locator("#pass").press("Enter");
	await expect(page.locator("#status")).toContainText("Library created.");
	await expectConfigured(page);
	return { code, ...(await storage(page)) };
}

async function downloadRecovery(page) {
	await page.getByRole("button", { name: "Download recovery file" }).click();
	await expect(page.locator("#status")).toContainText(
		"Recovery download started",
	);
	return page.evaluate(() => window.lastDownload);
}

async function resetLibrary(page, accept = true) {
	page.once("dialog", async (dialog) => {
		expect(dialog.type()).toBe("confirm");
		if (accept) await dialog.accept();
		else await dialog.dismiss();
	});
	await openReset(page);
	await page
		.getByRole("button", { name: "Reset everything", exact: true })
		.click();
	if (accept)
		await expect(page.locator("#status")).toContainText(
			"Browser settings reset",
		);
}

const execFileAsync = promisify(execFile);

async function issueOtc(dataDir) {
	const { stdout } = await execFileAsync(
		"cargo",
		["run", "--quiet", "--", "otc", "issue", "--data-dir", dataDir],
		{ cwd: root },
	);
	return stdout.trim();
}

async function shot(page, name) {
	await mkdir(path.join(root, "client/e2e/shots"), { recursive: true });
	await page.emulateMedia({ colorScheme: "light" });
	await page.screenshot({
		path: path.join(root, "client/e2e/shots", `${name}-light.png`),
		fullPage: true,
	});
	await page.emulateMedia({ colorScheme: "dark" });
	const bg = await page.evaluate(
		() => getComputedStyle(document.body).backgroundColor,
	);
	expect(bg).toBe("rgb(28, 27, 25)");
	await page.screenshot({
		path: path.join(root, "client/e2e/shots", `${name}-dark.png`),
		fullPage: true,
	});
	await page.emulateMedia({ colorScheme: "light" });
}

function installBrowser() {
	const listeners = [];
	const notify = (before, after, area) => {
		const changes = {};
		for (const key of new Set([
			...Object.keys(before),
			...Object.keys(after),
		])) {
			if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
				changes[key] = { oldValue: before[key], newValue: after[key] };
			}
		}
		for (const listener of listeners) listener(changes, area);
	};
	const bag = (storage, area) => ({
		async get(keys) {
			const all = JSON.parse(storage.getItem("i2nclip-e2e") || "{}");
			if (keys == null) return { ...all };
			const names = Array.isArray(keys) ? keys : [keys];
			const out = {};
			for (const name of names) if (name in all) out[name] = all[name];
			return out;
		},
		async set(values) {
			const all = JSON.parse(storage.getItem("i2nclip-e2e") || "{}");
			const next = { ...all, ...values };
			storage.setItem("i2nclip-e2e", JSON.stringify(next));
			notify(all, next, area);
		},
		async remove(key) {
			const all = JSON.parse(storage.getItem("i2nclip-e2e") || "{}");
			const next = { ...all };
			delete next[key];
			storage.setItem("i2nclip-e2e", JSON.stringify(next));
			notify(all, next, area);
		},
		async clear() {
			const all = JSON.parse(storage.getItem("i2nclip-e2e") || "{}");
			storage.removeItem("i2nclip-e2e");
			notify(all, {}, area);
		},
	});
	globalThis.browser = {
		runtime: { getURL: (file) => new URL(file, location.href).href },
		storage: {
			local: bag(localStorage, "local"),
			session: bag(sessionStorage, "session"),
			onChanged: {
				addListener: (listener) => listeners.push(listener),
				removeListener: (listener) => {
					const index = listeners.indexOf(listener);
					if (index !== -1) listeners.splice(index, 1);
				},
			},
		},
		notifications: { create: async () => {} },
		downloads: {
			download: async ({ url }) => {
				window.lastDownload = await (await fetch(url)).text();
				return 1;
			},
		},
	};
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function startApi(data, origin, listen) {
	const child = spawn(
		"cargo",
		["run", "--quiet", "--example", "e2e-server", "--", data, origin, listen],
		{
			cwd: root,
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) reject(new Error("e2e server did not start"));
		}, 90_000);
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString();
			if (!settled && buf.includes("ready ")) {
				settled = true;
				clearTimeout(timer);
				resolve(child);
			}
		});
		child.once("exit", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(new Error(`e2e server exited ${code}`));
			}
		});
	});
}

function startWeb() {
	return new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			try {
				const url = new URL(req.url, "http://127.0.0.1");
				const file = path.normalize(
					path.join(root, decodeURIComponent(url.pathname)),
				);
				if (!file.startsWith(root)) {
					res.writeHead(403);
					res.end();
					return;
				}
				const { readFile } = await import("node:fs/promises");
				const body = await readFile(file);
				const type = file.endsWith(".js")
					? "text/javascript"
					: file.endsWith(".css")
						? "text/css"
						: file.endsWith(".svg")
							? "image/svg+xml"
							: "text/html";
				res.writeHead(200, { "content-type": type });
				res.end(body);
			} catch {
				res.writeHead(404);
				res.end();
			}
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				origin: `http://127.0.0.1:${port}`,
				close: () => server.close(),
			});
		});
		server.once("error", reject);
	});
}

export {
	chooseRestore,
	createLibrary,
	DEFAULT_SERVER,
	downloadRecovery,
	expect,
	expectConfigured,
	expectSetup,
	fillCreation,
	issueOtc,
	openReset,
	openServer,
	options,
	PASSWORD,
	png,
	resetLibrary,
	shot,
	storage,
	test,
};

// One second of silent PCM, playable by Firefox (not just a fake MIME type).
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
export async function videoFixture() {
	return {
		name: "Video.webm",
		mimeType: "video/webm",
		buffer: await readFile(new URL("./fixtures/clip.webm", import.meta.url)),
	};
}

export async function expireOtc(dataDir) {
	await execFileAsync("python3", [
		"-c",
		"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE registration_codes SET expires_at = 0'); c.commit()",
		path.join(dataDir, "i2nclip.db"),
	]);
}
