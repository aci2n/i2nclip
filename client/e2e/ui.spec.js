import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { expect, test as base } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

test("create, reset, recover, unlock, upload, and both color schemes", async ({ page, app }) => {
  const { data, origin, web } = app;
  await page.goto(`${web.origin}/client/dist/extension/library.html`);
  await expect(page.locator("#setup")).toBeVisible();
  await shot(page, "library-empty");

  await page.goto(`${web.origin}/client/dist/extension/options.html`);
  await expect(page.getByRole("button", { name: "Create library" })).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.locator('#create input[type="password"]')).toHaveCount(1);
  await shot(page, "options");

  await openServer(page);

  await page.locator("#server").fill(origin);
  await page.locator("#pass").fill("test-pass-1");
  await page.locator("#otc").fill("invalid-invitation");
  await page.getByRole("button", { name: "Create library", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Registration failed");
  await expect(page.locator("#create")).toBeVisible();
  await expect(page.locator("#restore-settings")).toBeHidden();
  await expect(page.locator("#configured")).toBeHidden();
  await expect(page.locator("#reset-settings")).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("i2nclip-e2e") || "{}").wrappedKey)).toBeUndefined();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("i2nclip-e2e") || "{}").privateKey)).toBeUndefined();
  const otc = await issueOtc(data);
  await page.locator("#otc").fill(otc);
  await page.locator("#pass").press("Enter");
  await expect(page.locator("#status")).toContainText("Library created.");
  await expect(page.locator("#create")).toBeHidden();
  await expect(page.locator("#registration")).toHaveCount(0);
  const identity = await page.evaluate(() => JSON.parse(localStorage.getItem("i2nclip-e2e")).publicKey);
  await page.getByRole("button", { name: "Download recovery file" }).click();
  await expect(page.locator("#status")).toContainText("Recovery download started");
  const recovery = await page.evaluate(() => window.lastDownload);
  expect(JSON.parse(recovery).wrappedKey.ct).toBeTruthy();
  await shot(page, "options-configured");

  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.getByRole("heading", { name: "Your library is empty", exact: true })).toBeVisible();
  await page.locator("#files").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".card strong")).toHaveText("dot.png");
  await expect(page.locator(".card img")).toBeVisible();
  await page.locator(".card img").click();
  await expect(page.locator(".card .media img")).toBeVisible();
  await expect(page.locator("#full img")).toBeVisible();
  await page.locator("#full").click({ position: { x: 2, y: 2 } });
  await shot(page, "library-card");

  // Reset the configured library, then recover and decrypt the existing upload.
  await page.goto(`${web.origin}/client/dist/extension/options.html`);
  await expect(page.locator("#restore-settings")).toBeHidden();
  page.once("dialog", (dialog) => dialog.dismiss());
  await openReset(page);
  await page.getByRole("button", { name: "Reset everything", exact: true }).click();
  await expect(page.locator("#configured")).toBeVisible();
  await expect(page.locator("#restore-settings")).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("i2nclip-e2e")).wrappedKey)).toBeTruthy();
  page.once("dialog", (dialog) => dialog.accept());
  await openReset(page);
  await page.getByRole("button", { name: "Reset everything", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Browser settings reset");
  await expect(page.locator("#create")).toBeVisible();
  await expect(page.locator("#restore-settings")).toBeHidden();
  await expect(page.locator("#configured")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("i2nclip-e2e"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("i2nclip-e2e"))).toBeNull();
  await chooseRestore(page);
  await page.locator("#file").setInputFiles({ name: "i2nclip-recovery.json", mimeType: "application/json", buffer: Buffer.from(recovery) });
  await page.locator("#restore-pass").fill("wrong-password");
  await page.getByRole("button", { name: "Restore library", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Wrong password");
  await expect(page.locator("#restore-settings")).toBeVisible();
  await page.locator("#restore-pass").fill("test-pass-1");
  await page.locator("#restore-pass").press("Enter");
  await expect(page.locator("#status")).toHaveText("Library restored and unlocked.");
  await expect(page.locator("#restore-settings")).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("i2nclip-e2e")).publicKey)).toBe(identity);
  await page.evaluate(() => browser.storage.session.clear());
  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.locator("#unlock")).toBeVisible();
  await page.locator('#unlock input[type="password"]').fill("test-pass-1");
  await page.locator('#unlock button[type="submit"]').click();
  await expect(page.locator(".card strong")).toHaveText("dot.png");
  await page.locator(".card img").click();
  await expect(page.locator("#full img")).toBeVisible();

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
  await expect(page.getByRole('tab', { name: 'Create', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Restore', exact: true })).toBeVisible();
  await expect(page.locator("#configured")).toBeHidden();
  await expect(page.locator("#reset-settings")).toBeHidden();
}

async function openServer(page) {
  const details = page.locator('#server-details');
  if (!await details.evaluate((element) => element.open)) await details.locator('summary').click();
}

async function openReset(page) {
  const details = page.locator('#reset-settings');
  if (!await details.evaluate((element) => element.open)) await details.locator('summary').click();
}

async function chooseRestore(page) {
  await page.getByRole('tab', { name: 'Restore', exact: true }).click();
  await expect(page.locator('#restore-settings')).toBeVisible();
  await expect(page.locator('#create')).toBeHidden();
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
  await expect(page.locator("#status")).toContainText("Recovery download started");
  return page.evaluate(() => window.lastDownload);
}

async function resetLibrary(page, accept = true) {
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await openReset(page);
  await page.getByRole("button", { name: "Reset everything", exact: true }).click();
  if (accept) await expect(page.locator("#status")).toContainText("Browser settings reset");
}

test("fresh setup defaults to the public server", async ({ page, app }) => {
  await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
  await expect(page.locator("#server")).toHaveValue(DEFAULT_SERVER);
  await expectSetup(page);
  expect(await storage(page)).toEqual({ local: {}, session: {} });
});

for (const submit of ["click", "Enter"]) {
  for (const accepted of [false, true]) {
    test(`pending registration stores no identity: ${submit}, ${accepted ? "accepted" : "rejected"}`, async ({ page, app }) => {
      await options(page, app);
      await fillCreation(page, accepted ? await issueOtc(app.data) : "invalid-code");
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let requests = 0;
      let payload;
      await page.route("**/api/register-key", async (route) => {
        requests++;
        payload = route.request().postDataJSON();
        await gate;
        await route.continue();
      });
      const before = await storage(page);
      if (submit === "click") await page.locator("#create-library").click();
      else await page.locator("#pass").press("Enter");
      try {
        await expect.poll(() => requests).toBe(1);
        await expect(page.locator("#create-library")).toBeDisabled();
        await expectSetup(page);
        expect(await storage(page)).toEqual(before);
        expect(Object.keys(payload).sort()).toEqual(["otc", "public_key"]);
        // Submitting a busy form again must not consume another invitation.
        await page.locator("#create").evaluate((form) => form.requestSubmit());
        expect(await storage(page)).toEqual(before);
      } finally { release(); }
      await expect(page.locator("#status")).toContainText(accepted ? "Library created." : "Registration failed");
      expect(requests).toBe(1);
      if (accepted) {
        await expectConfigured(page);
        expect((await storage(page)).local.publicKey).toBe(payload.public_key);
      } else {
        await expectSetup(page);
        expect(await storage(page)).toEqual(before);
      }
    });
  }
}

const invalidCreation = [
  ["missing server", "server", "", "valueMissing"],
  ["invalid server", "server", "not-a-url", "typeMismatch"],
  ["missing invitation", "otc", "", "valueMissing"],
  ["missing password", "pass", "", "valueMissing"],
  ["short password", "pass", "1234567", "tooShort"],
];

for (const [name, field, value, validity] of invalidCreation) {
  test(`creation validation: ${name}`, async ({ page, app }) => {
    await options(page, app);
    await fillCreation(page, "unused-code");
    // Keyboard input makes minlength validation behave as it does for a user.
    await page.locator(`#${field}`).fill("");
    if (value) await page.locator(`#${field}`).pressSequentially(value);
    let registrations = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/register-key")) registrations++;
    });
    const before = await storage(page);
    await page.getByRole("button", { name: "Create library", exact: true }).click();
    await expect.poll(() => page.locator(`#${field}`).evaluate((input, flag) => input.validity[flag], validity)).toBe(true);
    await expectSetup(page);
    expect(await storage(page)).toEqual(before);
    expect(registrations).toBe(0);
  });
}

for (const failure of ["invalid code", "expired code", "used code", "network error", "server error", "lost response", "whitespace code"]) {
  test(`registration failure leaves no identity: ${failure}`, async ({ page, app }) => {
    await options(page, app);
    let code = "invalid-code";
    if (failure === "expired code") {
      code = await issueOtc(app.data);
      await execFileAsync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE registration_codes SET expires_at = 0'); c.commit()", path.join(app.data, "i2nclip.db")]);
    } else if (failure === "used code") {
      ({ code } = await createLibrary(page, app));
      await resetLibrary(page);
      await openServer(page);
      await page.locator("#server").fill(app.origin);
    } else if (failure === "whitespace code") {
      code = "   ";
    } else if (["network error", "server error", "lost response"].includes(failure)) {
      code = await issueOtc(app.data);
      await page.route("**/api/register-key", async (route) => {
        if (failure === "server error") await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"test server error"}' });
        else {
          if (failure === "lost response") await route.fetch();
          await route.abort("failed");
        }
      });
    }
    await fillCreation(page, code);
    const before = await storage(page);
    await page.locator("#pass").press("Enter");
    await expect(page.locator("#status")).toContainText(failure === "whitespace code" ? "Enter an invitation code" : "Registration failed");
    await expectSetup(page);
    expect(await storage(page)).toEqual(before);
    // A valid retry succeeds without requiring reset.
    await page.unroute("**/api/register-key");
    await page.locator("#otc").fill(await issueOtc(app.data));
    await page.locator("#pass").press("Enter");
    await expect(page.locator("#status")).toContainText("Library created.");
    await expectConfigured(page);
  });
}

for (const theme of ["light", "dark"]) {
  for (const state of ["empty", "locked", "unlocked"]) {
    test(`settings visibility and recovery download: ${state}, ${theme}`, async ({ page, app }) => {
      await page.emulateMedia({ colorScheme: theme });
      await options(page, app);
      if (state === "empty") {
        await expectSetup(page);
        await expect(page.locator("#reset")).toBeHidden();
        await expect(page.locator("#backup")).toBeHidden();
      } else {
        const created = await createLibrary(page, app);
        if (state === "locked") await page.evaluate(() => browser.storage.session.clear());
        await page.reload();
        await expectConfigured(page);
        const before = await storage(page);
        const recovery = JSON.parse(await downloadRecovery(page));
        expect(recovery.serverUrl).toBe(app.origin);
        expect(recovery.wrappedKey).toEqual(created.local.wrappedKey);
        expect(recovery).not.toHaveProperty("privateKey");
        expect(JSON.stringify(recovery)).not.toContain(JSON.parse(created.session.privateKey).seed);
        expect(await storage(page)).toEqual(before);
        await page.getByRole("link", { name: "Library" }).click();
        if (state === "locked") await expect(page.locator("#unlock")).toBeVisible();
        else {
          await expect(page.locator("#unlock")).toBeHidden();
          await expect(page.getByRole("heading", { name: "Your library is empty", exact: true })).toBeVisible();
        }
      }
    });
  }
}

for (const state of ["locked", "unlocked"]) {
  for (const accept of [false, true]) {
    test(`reset ${accept ? "confirmed" : "cancelled"}: ${state}`, async ({ page, app }) => {
      await createLibrary(page, app);
      if (state === "locked") await page.evaluate(() => browser.storage.session.clear());
      await page.reload();
      const before = await storage(page);
      await resetLibrary(page, accept);
      if (accept) {
        await expectSetup(page);
        await expect(page.locator("#server")).toHaveValue(DEFAULT_SERVER);
        expect(await storage(page)).toEqual({ local: {}, session: {} });
        await page.reload();
        await expectSetup(page);
      } else {
        await expectConfigured(page);
        expect(await storage(page)).toEqual(before);
        await page.reload();
        await expectConfigured(page);
      }
    });
  }
}

for (const failure of ["missing file", "missing password", "malformed JSON", "wrong format", "wrong version", "invalid server", "invalid envelope", "excessive iterations", "oversized file", "wrong password", "damaged ciphertext", "mismatched identity"]) {
  test(`recovery failure preserves setup: ${failure}`, async ({ page, app }) => {
    const created = await createLibrary(page, app);
    let recovery = await downloadRecovery(page);
    await resetLibrary(page);
    await chooseRestore(page);
    const document = JSON.parse(recovery);
    if (failure === "malformed JSON") recovery = "not JSON";
    if (failure === "wrong format") document.format = "other-format";
    if (failure === "wrong version") document.v = 2;
    if (failure === "invalid server") document.serverUrl = "javascript:alert(1)";
    if (failure === "invalid envelope") document.wrappedKey.salt = "AAAA";
    if (failure === "excessive iterations") document.wrappedKey.iterations = 9_000_000;
    if (failure === "damaged ciphertext") {
      const bytes = Buffer.from(document.wrappedKey.ct, "base64");
      bytes[0] ^= 1;
      document.wrappedKey.ct = bytes.toString("base64");
    }
    if (failure === "mismatched identity") {
      document.wrappedKey = await page.evaluate(async ({ privateKey, password }) => {
        const { generatePrivateKey } = await import("/client/src/lib/identity.js");
        const { wrapPrivateKey } = await import("/client/src/lib/vault.js");
        const other = await generatePrivateKey();
        const mismatched = { ...JSON.parse(privateKey), publicKey: other.publicKey };
        return wrapPrivateKey(JSON.stringify(mismatched), password);
      }, { privateKey: created.session.privateKey, password: PASSWORD });
    }
    if (failure !== "malformed JSON") recovery = JSON.stringify(document);
    if (failure === "oversized file") recovery = " ".repeat(16_385);
    if (failure !== "missing file") await page.locator("#file").setInputFiles({ name: "recovery.json", mimeType: "application/json", buffer: Buffer.from(recovery) });
    await page.locator("#restore-pass").fill(failure === "missing password" ? "" : failure === "wrong password" ? "wrong-password" : PASSWORD);
    // Saving a server URL also verifies a failed restore preserves existing settings.
    await openServer(page);
    await page.locator("#server").fill(app.origin);
    await page.locator("#save-server").click();
    const before = await storage(page);
    await page.locator("#restore").click();
    if (failure === "missing file" || failure === "missing password") {
      const input = page.locator(failure === "missing file" ? "#file" : "#restore-pass");
      expect(await input.evaluate((input) => input.validity.valueMissing)).toBe(true);
    } else {
      await expect(page.locator("#status")).toContainText(failure === "mismatched identity" ? "does not match" : ["wrong password", "damaged ciphertext"].includes(failure) ? "Wrong password" : "Invalid");
    }
    await expectSetup(page);
    expect(await storage(page)).toEqual(before);
  });
}

for (const submit of ["click", "Enter"]) {
  test(`restore succeeds without registration: ${submit}`, async ({ page, app }) => {
    const created = await createLibrary(page, app);
    const recovery = await downloadRecovery(page);
    await resetLibrary(page);
    await chooseRestore(page);
    await page.route("**/api/register-key", () => { throw new Error("Restore must not register again"); });
    await page.locator("#file").setInputFiles({ name: "recovery.json", mimeType: "application/json", buffer: Buffer.from(recovery) });
    await page.locator("#restore-pass").fill(PASSWORD);
    if (submit === "click") await page.locator("#restore").click();
    else await page.locator("#restore-pass").press("Enter");
    await expect(page.locator("#status")).toHaveText("Library restored and unlocked.");
    await expectConfigured(page);
    const restored = await storage(page);
    expect(restored.local).toEqual(created.local);
    expect(restored.session.privateKey).toBe(created.session.privateKey);
    await page.reload();
    await expectConfigured(page);
    await expect(page.locator("#server")).toHaveValue(app.origin);
  });
}

for (const state of ["locked", "unlocked"]) {
  test(`server update preserves library: ${state}`, async ({ page, app }) => {
    await createLibrary(page, app);
    if (state === "locked") await page.evaluate(() => browser.storage.session.clear());
    await page.reload();
    const before = await storage(page);
    await openServer(page);
    await page.locator("#server").fill("not-a-url");
    await page.locator("#save-server").click();
    expect(await storage(page)).toEqual(before);
    const serverUrl = "https://new.example.com";
    await openServer(page);
    await page.locator("#server").fill(serverUrl);
    await page.locator("#server").press("Enter");
    await expect(page.locator("#status")).toHaveText("Server URL updated.");
    expect(await storage(page)).toEqual({ local: { ...before.local, serverUrl }, session: before.session });
    expect(JSON.parse(await downloadRecovery(page)).serverUrl).toBe(serverUrl);
    await page.reload();
    await expect(page.locator("#server")).toHaveValue(serverUrl);
    await expectConfigured(page);
  });
}

for (const password of ["wrong-password", PASSWORD]) {
  test(`unlock ${password === PASSWORD ? "succeeds" : "fails"} without modifying the saved identity`, async ({ page, app }) => {
    await createLibrary(page, app);
    await page.evaluate(() => browser.storage.session.clear());
    const before = await storage(page);
    await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
    await expect(page.locator("#unlock")).toBeVisible();
    await page.locator("#pass").fill(password);
    await page.locator("#pass").press("Enter");
    if (password === PASSWORD) {
      await expect(page.locator("#unlock")).toBeHidden();
      await expect(page.getByRole("heading", { name: "Your library is empty", exact: true })).toBeVisible();
      expect((await storage(page)).session.privateKey).toBeTruthy();
    } else {
      await expect(page.locator("#unlock-status")).toContainText("Wrong password");
      await expect(page.locator("#unlock")).toBeVisible();
      expect((await storage(page)).session).toEqual(before.session);
    }
    expect((await storage(page)).local).toEqual(before.local);
  });
}

test("deleted cards stay visible and fade after success", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  await page.locator("#files").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  const card = page.locator(".card");
  await expect(card).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await card.locator('[data-act="delete"]').click();
  await expect(card).toHaveClass(/deleted/);
  await expect(card).toHaveCSS("opacity", "0.2");
  await page.reload();
  await expect(page.locator(".card")).toHaveCount(0);
});

test("clearing the identity invalidates an open library", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  await expect(page.getByRole("heading", { name: "Your library is empty", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await browser.storage.session.clear();
    await browser.storage.local.clear();
  });
  await expect(page.locator("#setup")).toBeVisible();
});

test("tag edits preserve the preview and remain searchable", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  await page.locator("#files").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  const card = page.locator(".card");
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Add tag to dot.png' }).click();
  await card.locator('.tags input').fill(" Vacation, dog ");
  await shot(page, 'tag-editor');
  await page.setViewportSize({ width: 360, height: 740 });
  await shot(page, 'tag-editor-narrow');
  await card.getByRole('button', { name: 'Save tag', exact: true }).click();
  await expect(card.locator('.tag-text')).toHaveText(['Vacation', 'dog']);
  await expect(card.locator('output')).toBeHidden();
  await page.locator("#tags").fill("vacation");
  await page.locator("#tags").press("Enter");
  await expect(card.locator("strong")).toHaveText("dot.png");
  await expect(card.locator(".media img")).toBeVisible();
  await expect(card.locator('.tag-text')).toHaveText(['Vacation', 'dog']);
  await expect(card.getByRole('button', { name: 'Add tag to dot.png' })).toBeVisible();
  await page.locator("#tags").fill("missing");
  await page.locator("#tags").press("Enter");
  await expect(card).toHaveCount(0);
});

test("a failed content fetch can be retried", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  await page.locator("#files").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  const card = page.locator(".card");
  await expect(card).toHaveCount(1);
  let requests = 0;
  await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
    requests++;
    if (requests === 1) await route.fulfill({ status: 503, body: "Temporary failure" });
    else await route.continue();
  });
  await card.locator("img").click();
  await expect(card.locator("output")).toHaveText("Temporary failure");
  await expect(page.locator("#full")).not.toBeVisible();
  await card.locator("img").click();
  await expect(page.locator("#full img")).toBeVisible();
  expect(requests).toBe(2);
});

test("upload popup keeps its pending source after failure and retries once", async ({ page, app }) => {
  await createLibrary(page, app);
  const srcUrl = `${app.web.origin}/remote.png`;
  await page.route('**/remote.png', (route) => route.fulfill({ contentType: 'image/png', body: png }));
  await page.evaluate(async (source) => browser.storage.session.set({ 'upload:popup': source }), { srcUrl });
  await page.addInitScript(() => { window.close = () => { window.uploadClosed = true; }; });
  let uploads = 0;
  await page.route('**/api/media', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (++uploads === 1) return route.fulfill({ status: 503, body: 'Temporary failure' });
    return route.continue();
  });
  await page.goto(`${app.web.origin}/client/dist/extension/upload.html?id=popup`);
  await expect(page.locator('#preview')).toBeVisible();
  await page.locator('#tags').fill('vacation');
  await page.locator('#send button').click();
  await expect(page.locator('#status')).toHaveText('Temporary failure');
  expect((await storage(page)).session['upload:popup']).toBeTruthy();
  await page.locator('#send button').click();
  await expect(page.locator('#status')).toHaveText('Uploaded.');
  expect((await storage(page)).session['upload:popup']).toBeUndefined();
  expect(await page.evaluate(() => window.uploadClosed)).toBe(true);
  expect(uploads).toBe(2);
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.locator('.card strong')).toHaveText('remote.png');
  await expect(page.locator('.tag-text')).toHaveText('vacation');
});

test("unlock popup resumes only its own queued upload", async ({ page, app }) => {
  await createLibrary(page, app);
  const srcUrl = `${app.web.origin}/remote.png`;
  await page.route('**/remote.png', (route) => route.fulfill({ contentType: 'image/png', body: png }));
  await page.evaluate(async (source) => {
    await browser.storage.session.clear();
    await browser.storage.session.set({ 'upload:first': source, 'upload:second': { ...source, srcUrl: 'https://other.example/image.png' } });
  }, { srcUrl });
  await page.addInitScript(() => { window.close = () => { window.uploadClosed = true; }; });
  await page.goto(`${app.web.origin}/client/dist/extension/unlock.html?id=first`);
  await page.locator('#pass').fill(PASSWORD);
  await page.locator('#pass').press('Enter');
  await expect(page.locator('#status')).toHaveText('Uploaded.');
  const saved = await storage(page);
  expect(saved.session['upload:first']).toBeUndefined();
  expect(saved.session['upload:second']).toBeTruthy();
  expect(await page.evaluate(() => window.uploadClosed)).toBe(true);
});

test("setup errors stay beside the active form on narrow screens", async ({ page, app }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await options(page, app);
  await page.locator('#server-details > summary').click();
  await fillCreation(page, 'invalid-invitation');
  await page.locator('#pass').press('Enter');
  await expect(page.locator('#create #status')).toContainText('Registration failed');
  await expect(page.locator('#create #status')).toBeInViewport();
  await expect(page.locator('#create #status')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#restore-settings')).toBeHidden();
  expect(await page.locator('#server-details').evaluate((element) => element.open)).toBe(false);
  await shot(page, 'setup-error-narrow');
  await chooseRestore(page);
  await expect(page.locator('#create #status')).toBeHidden();
  await shot(page, 'restore-narrow');
  const restoreTab = page.getByRole('tab', { name: 'Restore', exact: true });
  const createTab = page.getByRole('tab', { name: 'Create', exact: true });
  await restoreTab.focus();
  await restoreTab.press('ArrowLeft');
  await expect(createTab).toBeFocused();
  await expect(createTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Create', exact: true })).toBeVisible();
  await createTab.press('End');
  await expect(restoreTab).toBeFocused();
  await expect(restoreTab).toHaveAttribute('aria-selected', 'true');
  await restoreTab.press('Home');
  await expect(createTab).toBeFocused();

});

test("empty library upload and clear-search actions work", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  await expect(page.getByRole('heading', { name: 'Your library is empty', exact: true })).toBeVisible();
  await shot(page, 'empty-library');
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  await (await choosing).setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card .tags input')).toBeHidden();
  await page.locator('#tags').fill('missing');
  await page.locator('#tags').press('Enter');
  await expect(page.getByRole('heading', { name: 'No matching clips', exact: true })).toBeVisible();
  await shot(page, 'no-search-results');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.locator('#tags')).toHaveValue('');
  await expect(page.locator('.card strong')).toHaveText('dot.png');
});

test("mixed media has consistent previews without narrow-screen overflow", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  const files = [];
  for (const [width, height, name] of [[960, 640, 'Mountains.png'], [640, 960, 'A long portrait filename that wraps onto a second line.png'], [1600, 360, 'Panorama.png']]) {
    const encoded = await page.evaluate(({ width, height }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#8fbdc5'); gradient.addColorStop(1, '#e5d5ab');
      context.fillStyle = gradient; context.fillRect(0, 0, width, height);
      context.fillStyle = '#e9c77a'; context.beginPath(); context.arc(width * .72, height * .26, Math.min(width, height) * .09, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#466957'; context.beginPath(); context.moveTo(0, height); context.lineTo(0, height * .75); context.lineTo(width * .3, height * .38); context.lineTo(width * .6, height * .7); context.lineTo(width * .9, height * .5); context.lineTo(width, height * .65); context.lineTo(width, height); context.fill();
      return canvas.toDataURL('image/png').split(',')[1];
    }, { width, height });
    files.push({ name, mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') });
  }
  files.push({ name: 'Voice memo.wav', mimeType: 'audio/wav', buffer: Buffer.from('audio-preview-fixture') });
  files.push({ name: 'Notes.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('file') });
  await page.locator('#files').setInputFiles(files);
  await expect(page.locator('.card')).toHaveCount(5);
  const heights = await page.locator('.media').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
  await shot(page, 'mixed-media');
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, `mixed-media-${width}`);
  }
});

test("upload batches show filenames, continue after failure, and retry only failed files", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  let posts = 0;
  await page.route('**/api/media', async (route) => {
    if (route.request().method() === 'POST' && ++posts === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary failure' }) });
    } else await route.continue();
  });
  await page.locator('#files').setInputFiles([
    { name: 'retry.png', mimeType: 'image/png', buffer: png },
    { name: 'saved.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(page.locator('.card strong')).toHaveText('saved.png');
  await expect(page.getByRole('region', { name: 'Failed uploads' })).toContainText('retry.png');
  await expect(page.locator('#status')).toBeEmpty();
  await shot(page, 'upload-failure');
  await page.getByRole('button', { name: 'Retry failed files' }).click();
  await expect(page.locator('.card')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Failed uploads' })).toBeHidden();
  expect(posts).toBe(3);
});

for (const change of ['server', 'reset']) {
  test(`changing ${change} cancels a slow upload and the remaining batch`, async ({ page, app }) => {
    await createLibrary(page, app);
    await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; });
    const requestStarted = new Promise((resolve) => { started = resolve; });
    let posts = 0;
    await page.route('**/api/media', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++; started(); await gate;
      await route.fulfill({ status: 503, body: 'Old upload failure' }).catch(() => {});
    });
    try {
      await page.locator('#files').setInputFiles([
        { name: 'slow.png', mimeType: 'image/png', buffer: png },
        { name: 'never-sent.png', mimeType: 'image/png', buffer: png },
      ]);
      await requestStarted;
      await expect(page.getByRole('region', { name: 'Upload progress' })).toContainText('Uploading 1 of 2: slow.png');
      await shot(page, 'upload-progress');
      await page.evaluate(async ({ change, origin }) => {
        if (change === 'server') await browser.storage.local.set({ serverUrl: `${origin}/changed` });
        else { await browser.storage.session.clear(); await browser.storage.local.clear(); }
      }, { change, origin: app.origin });
      await expect(page.getByRole('region', { name: 'Upload progress' })).toBeHidden();
      if (change === 'reset') await expect(page.locator('#setup')).toBeVisible();
      else await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible();
    } finally { release(); }
    await expect(page.getByRole('region', { name: 'Failed uploads' })).toBeHidden();
    expect(posts).toBe(1);
  });
}

test("inline tag saves deduplicate and guard a slow request", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  await page.locator('#files').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: png });
  const card = page.locator('.card');
  await expect(card).toHaveCount(1);
  const add = card.getByRole('button', { name: 'Add tag to first.png' });
  await add.focus();
  await add.press('Enter');
  const input = card.locator('.tags input');
  await expect(input).toBeFocused();
  await input.fill('Vacation, vacation, dog, DOG');
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let saves = 0;
  await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    saves++; started(); await gate; await route.continue();
  });
  try {
    await input.press('Enter');
    await requestStarted;
    await expect(card.getByRole('button', { name: 'Save tag' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(card.locator('.tag-text')).toHaveText(['Vacation', 'dog']);
  await expect(card.locator('output')).toBeHidden();
  await expect(add).toBeFocused();
  expect(saves).toBe(1);
});

test("uploads continue across Library and Settings views and retain progress", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { started = resolve; });
  await page.route('**/api/media', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    started(); await gate; await route.continue();
  });
  try {
    await page.locator('#files').setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: png });
    await requestStarted;
    await expect(page.getByRole('region', { name: 'Upload progress' })).toContainText('Uploading 1 of 1: slow.png');
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/options\.html$/);
    await page.getByRole('link', { name: 'Library' }).click();
    await expect(page).toHaveURL(/library\.html$/);
    await expect(page.getByRole('region', { name: 'Upload progress' })).toContainText('Uploading 1 of 1: slow.png');
  } finally { release(); }
  await expect(page.locator('.card strong')).toHaveText('slow.png');
  await expect(page.getByRole('region', { name: 'Upload progress' })).toBeHidden();
  await expect(page.locator('#status')).toBeEmpty();
});

test("a slow search cannot clear the newer search results", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  await page.locator('#files').setInputFiles({ name: 'saved.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.card strong')).toHaveText('saved.png');
  let release, started, finished;
  const gate = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const requestFinished = new Promise((resolve) => { finished = resolve; });
  await page.route('**/api/media?*', async (route) => {
    started(); await gate;
    try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ media: [], next: null }) }); }
    catch { /* Superseded requests can already be cancelled by Firefox. */ }
    finally { finished(); }
  });
  try {
    await page.locator('#tags').fill('missing');
    await page.locator('#tags').press('Enter');
    await requestStarted;
    await page.locator('#tags').fill('');
    await page.locator('#tags').press('Enter');
    await expect(page.locator('.card strong')).toHaveText('saved.png');
  } finally { release(); }
  await requestFinished;
  await expect(page.locator('.card strong')).toHaveText('saved.png');
  await expect(page.getByRole('heading', { name: 'No matching clips' })).toBeHidden();
});

test("inline tags keep failed drafts, restore the plus button, remove chips, and cancel", async ({ page, app }) => {
  await createLibrary(page, app);
  await page.goto(`${app.web.origin}/client/dist/extension/library.html`);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator('#files').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  const card = page.locator('.card');
  await expect(card).toHaveCount(1);
  let updates = 0;
  await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    if (++updates === 1) return route.fulfill({ status: 503, body: 'Try again' });
    await route.continue();
  });
  const add = card.getByRole('button', { name: 'Add tag to dot.png' });
  await add.click();
  const input = card.getByRole('textbox', { name: 'New tag for dot.png' });
  await expect(input).toBeFocused();
  await input.fill('dog');
  await input.press('Enter');
  await expect(card.locator('output')).toHaveText('Try again');
  await expect(input).toHaveValue('dog');
  await expect(input).toBeFocused();
  await expect(card.locator('.tag-text')).toHaveCount(0);
  await input.press('Enter');
  await expect(card.locator('.tag-text')).toHaveText(['dog']);
  await expect(add).toBeFocused();
  await expect(input).toBeHidden();
  await add.click();
  await input.fill('Cat');
  await card.getByRole('button', { name: 'Save tag', exact: true }).click();
  await expect(card.locator('.tag-text')).toHaveText(['dog', 'Cat']);
  await shot(page, 'inline-tag-chips');
  await card.getByRole('button', { name: 'Remove tag dog', exact: true }).click();
  await expect(card.locator('.tag-text')).toHaveText(['Cat']);
  await expect(add).toBeFocused();
  await add.click();
  await input.fill('unsaved');
  await input.press('Escape');
  await expect(add).toBeFocused();
  await expect(input).toBeHidden();
  await expect(card.locator('.tag-text')).toHaveText(['Cat']);
  expect(updates).toBe(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
  await mkdir(path.join(root, "client/e2e/shots"), { recursive: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: path.join(root, "client/e2e/shots", `${name}-light.png`), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(28, 27, 25)");
  await page.screenshot({ path: path.join(root, "client/e2e/shots", `${name}-dark.png`), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
}

function installBrowser() {
  const listeners = [];
  const notify = (before, after, area) => {
    const changes = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
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
      local: bag(localStorage, "local"), session: bag(sessionStorage, "session"),
      onChanged: { addListener: (listener) => listeners.push(listener) },
    },
    notifications: { create: async () => {} },
    downloads: { download: async ({ url }) => {
      window.lastDownload = await (await fetch(url)).text();
      return 1;
    } },
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
