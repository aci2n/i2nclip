import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("setup, upload, and both color schemes", async ({ page }) => {
  const data = await mkdtemp(path.join(tmpdir(), "i2nclip-e2e-"));
  const apiPort = await freePort();
  const origin = `http://127.0.0.1:${apiPort}`;
  const api = await startApi(data, origin, `127.0.0.1:${apiPort}`);
  const web = await startWeb();
  await page.context().addInitScript(installBrowser);
  try {
    await page.goto(`${web.origin}/extension/library.html`);
    await expect(page.locator("#setup")).toBeVisible();
    await shot(page, "library-empty");

    await page.goto(`${web.origin}/extension/options.html`);
    await expect(page.getByRole("button", { name: "Generate a key" })).toBeVisible();
    await shot(page, "options");

    await page.locator("#server").evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, origin);
    await page.getByRole("button", { name: "Generate a key" }).click();
    await expect(page.locator("#pub")).not.toHaveValue("");
    await page.locator("#pass").fill("test-pass-1");
    await page.locator("#pass2").fill("test-pass-1");
    const otc = await issueOtc(data);
    await page.locator("#otc").fill(otc);
    await page.getByRole("button", { name: "Register public key" }).click();
    await expect(page.locator("#status")).toContainText("registered");
    await page.getByRole("button", { name: "Save key in Firefox" }).click();
    await expect(page.locator("#status")).toContainText("Key saved in Firefox");

    await page.getByRole("link", { name: "Library" }).click();
    await expect(page.locator("#status")).toHaveText("Nothing stored for those tags.");
    await page.locator("#files").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
    await expect(page.locator(".card strong")).toHaveText("dot.png");
    await expect(page.locator(".card img")).toBeVisible();
    await page.locator(".card img").click();
    await expect(page.locator(".card .media img")).toBeVisible();
    await expect(page.locator("#full img")).toBeVisible();
    await page.locator("#full").click({ position: { x: 2, y: 2 } });
    await shot(page, "library-card");
  } finally {
    web.close();
    api.kill();
    await rm(data, { recursive: true, force: true });
  }
});

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
  await mkdir(path.join(root, "e2e/shots"), { recursive: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: path.join(root, "e2e/shots", `${name}-light.png`), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(28, 27, 25)");
  await page.screenshot({ path: path.join(root, "e2e/shots", `${name}-dark.png`), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
}

function installBrowser() {
  const bag = (storage) => ({
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
      storage.setItem("i2nclip-e2e", JSON.stringify({ ...all, ...values }));
    },
    async remove(key) {
      const all = JSON.parse(storage.getItem("i2nclip-e2e") || "{}");
      delete all[key];
      storage.setItem("i2nclip-e2e", JSON.stringify(all));
    },
  });
  globalThis.browser = {
    storage: { local: bag(localStorage), session: bag(sessionStorage) },
    downloads: { download: async () => 1 },
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
  const child = spawn("cargo", ["run", "--quiet", "--example", "e2e-server", "--", data, origin, listen], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
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
        const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
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
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
    server.once("error", reject);
  });
}
