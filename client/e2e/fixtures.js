import { execFile, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
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
		page.on("pageerror", (error) =>
			console.error("Browser error:", error.message),
		);
		const data = await fixtureDatabase("create");
		let api;
		let web;
		try {
			const apiPort = await freePort();
			const origin = `http://127.0.0.1:${apiPort}`;
			api = await startApi(data, origin, `127.0.0.1:${apiPort}`);
			web = await startWeb();
			await page.context().addInitScript(installBrowser);
			await use({ data, origin, web });
		} finally {
			web?.close();
			if (api && api.exitCode === null) {
				const exited = new Promise((resolve) => api.once("exit", resolve));
				api.kill();
				await exited;
			}
			await fixtureDatabase("drop", data);
		}
	},
});

const PASSWORD = "test-pass-1";
const DEFAULT_SERVER = "https://clip.i2n.duckdns.org";

async function master(page, password = PASSWORD) {
	await expect(page.locator("#master-password, header").first()).toBeVisible();
	if (await page.locator("#master-password").isVisible()) {
		await page.locator("#master-password").fill(password);
		if (await page.locator("#master-confirmation").isVisible())
			await page.locator("#master-confirmation").fill(password);
		await page.locator("#unlock-vault").click();
		await expect(page.locator("#master-password")).toBeHidden();
	}
}
async function options(page, app) {
	await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
	await master(page);
	await openServer(page);
	await page.locator("#server").fill(app.origin);
}

async function fillCreation(page, code) {
	await page.locator("#otc").fill(code);
}

async function storage(page) {
	return page.evaluate(async () => ({
		local: await window.serviceTest("config"),
		session: (await window.serviceTest("state")).session,
	}));
}

async function expectSetup(page) {
	await expect(
		page.getByRole("tab", { name: "OTC", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("tab", { name: "Restore", exact: true }),
	).toBeVisible();
	await expect(page.locator("#configured")).toBeHidden();
	await expect(page.locator("#reset-settings")).toBeVisible();
}

async function openServer(page) {
	await master(page);
	const details = page.locator("#server-details");
	if (!(await details.count())) return;
	if (!(await details.isVisible()))
		await page.locator("#rename-library-settings > summary").click();
	if (!(await details.evaluate((element) => element.open)))
		await details.locator("summary").click();
}

async function openReset(page) {
	const details = page.locator("#reset-settings");
	if (!(await details.evaluate((element) => element.open)))
		await details.locator("summary").click();
}

async function chooseRestore(page) {
	await master(page);
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
	await page.locator("#create-library").click();
	await expect(page.locator("#status")).toContainText("Library created.");
	await expectConfigured(page);
	return { code, ...(await storage(page)) };
}

async function downloadRecovery(page) {
	const manage = page.locator("#rename-library-settings");
	if (!(await manage.evaluate((element) => element.open)))
		await manage.locator("summary").click();
	await page.locator("#library-recovery-password").fill(PASSWORD);
	await page.locator("#library-recovery-confirm").fill(PASSWORD);
	await page.locator("#backup").click();
	await expect(manage.getByRole("status")).toContainText(
		"Recovery download started",
	);
	return page.evaluate(() => window.lastDownload);
}

async function resetLibrary(page, accept = true) {
	await page.bringToFront();
	page.once("dialog", async (dialog) => {
		expect(dialog.type()).toBe("confirm");
		if (accept) await dialog.accept();
		else await dialog.dismiss();
	});
	await openReset(page);
	await page
		.getByRole("button", { name: "Reset everything", exact: true })
		.click();
	if (accept) await master(page);
}

const execFileAsync = promisify(execFile);

async function issueOtc(databaseUrl) {
	const { stdout } = await execFileAsync(
		"cargo",
		["run", "--quiet", "--", "otc", "issue"],
		{ cwd: root, env: { ...process.env, I2N_DATABASE_URL: databaseUrl } },
	);
	return stdout.trim();
}

async function shot(page, name) {
	const directory = path.join(
		root,
		"client/e2e/shots",
		test.info().project.name || "default",
	);
	await mkdir(directory, { recursive: true });
	await page.emulateMedia({ colorScheme: "light" });
	await page.screenshot({
		path: path.join(directory, `${name}-light.png`),
		fullPage: true,
	});
	await page.emulateMedia({ colorScheme: "dark" });
	const bg = await page.evaluate(
		() => getComputedStyle(document.body).backgroundColor,
	);
	expect(bg).toBe("rgb(28, 27, 25)");
	await page.screenshot({
		path: path.join(directory, `${name}-dark.png`),
		fullPage: true,
	});
	await page.emulateMedia({ colorScheme: "light" });
}

function installBrowser() {
	const connectionListeners = new Set();
	function connect() {
		const extension = location.pathname.startsWith("/client/dist/extension/");
		const worker = new SharedWorker(
			extension ? "/client/dist/e2e/background.js" : "/assets/web-worker.js",
			{
				type: "module",
				name: extension ? "i2nclip-extension-test" : "i2nclip-service",
			},
		);
		const listeners = new Set(),
			disconnects = new Set();
		const port = {
			name: "i2nclip-service",
			postMessage: (message) => worker.port.postMessage(message),
			onMessage: {
				addListener: (fn) => listeners.add(fn),
				removeListener: (fn) => listeners.delete(fn),
			},
			onDisconnect: {
				addListener: (fn) => disconnects.add(fn),
				removeListener: (fn) => disconnects.delete(fn),
			},
			disconnect() {
				worker.port.postMessage({ type: "detach" });
				worker.port.close();
			},
		};
		worker.port.onmessage = ({ data }) => {
			for (const listener of listeners) listener(data);
		};
		worker.onerror = () => {
			for (const listener of disconnects) listener();
		};
		worker.port.start();
		connectionListeners.add(port);
		return port;
	}
	window.browser = {
		runtime: { connect, getURL: (path) => `/client/dist/extension/${path}` },
		downloads: {
			download: async ({ url }) => {
				const response = await fetch(url);
				window.lastDownload = response.headers
					.get("content-type")
					?.includes("json")
					? await response.text()
					: Array.from(new Uint8Array(await response.arrayBuffer()));
				return 1;
			},
		},
	};
	window.serviceTest = async (name, payload = {}) => {
		if (name === "config") {
			const state = await window.serviceTest("state");
			return { ...state.session, vault: state.vault };
		}
		const port = connect();
		let instanceId;
		let epoch;
		const requestId = crypto.randomUUID();
		try {
			return await new Promise((resolve, reject) => {
				port.onMessage.addListener((message) => {
					if (message.type === "snapshot" && !instanceId) {
						instanceId = message.instanceId;
						const libraryId =
							new URLSearchParams(location.search).get("library") ||
							message.value.catalog?.[0]?.id ||
							message.value.setups?.[0]?.id;
						const selected =
							message.value.libraries?.[libraryId] || message.value;
						epoch = selected.session.epoch;
						if (name === "state") {
							resolve({
								...selected,
								vault: message.value.vault,
								catalog: message.value.catalog,
								setups: message.value.setups,
								libraries: message.value.libraries,
							});
							return;
						}
						if (name === "config")
							port.postMessage({ type: "test.config", requestId, libraryId });
						else if (name === "pauseUploads" || name === "resumeUploads")
							port.postMessage({ type: `test.${name}`, requestId });
						else if (name === "context")
							port.postMessage({
								type: "test.context",
								requestId,
								libraryId,
								...payload,
							});
						else if (name === "restart") {
							port.postMessage({ type: "test.restart" });
							resolve(true);
						} else
							port.postMessage({
								type: "command",
								instanceId,
								requestId,
								name,
								payload: { ...payload, epoch, libraryId },
							});
					}
					if (
						["reply", "test.reply"].includes(message.type) &&
						message.requestId === requestId
					) {
						if (message.error) reject(new Error(message.error.message));
						else resolve(message.value);
					}
				});
			});
		} finally {
			port.disconnect();
		}
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
		["run", "--quiet", "--example", "e2e-server", "--", origin, listen],
		{
			cwd: root,
			env: { ...process.env, I2N_DATABASE_URL: data },
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill();
				reject(new Error("e2e server did not start"));
			}
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
	master,
	chooseRestore,
	createLibrary,
	DEFAULT_SERVER,
	downloadRecovery,
	expect,
	expectConfigured,
	expectSetup,
	fillCreation,
	installBrowser,
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

export async function expireOtc(databaseUrl) {
	await fixtureDatabase("expire", databaseUrl);
}

async function fixtureDatabase(operation, target) {
	const { stdout } = await execFileAsync(
		"cargo",
		["run", "--quiet", "--example", "test-database", "--", operation],
		{
			cwd: root,
			env: { ...process.env, ...(target ? { I2N_DATABASE_URL: target } : {}) },
		},
	);
	return stdout.trim();
}

export async function openPopup(page, url) {
	const opening = page.waitForEvent("popup");
	await page.evaluate((target) => {
		window.open(target, "_blank");
	}, url);
	return opening;
}
