import { generatePrivateKey, registerKey } from "../client/index.js";
import { parseRecoveryFile, recoveryFile } from "../client/recovery.js";
import { readLocal, restoreWrappedKey, saveWrappedKey } from "./secrets.js";

const $ = (id) => document.querySelector(`#${id}`);
const server = $("server");
const status = $("status");
await refresh();

async function refresh() {
  const saved = await readLocal();
  server.value = saved.serverUrl;
  $("create").hidden = Boolean(saved.wrappedKey);
  $("configured").hidden = !saved.wrappedKey;
  $("reset-settings").hidden = !saved.wrappedKey;
  $("restore-settings").hidden = Boolean(saved.wrappedKey);
}

// Serialize settings changes so a slow create or restore cannot overwrite another action.
let busy = false;
async function run(action) {
  if (busy) return;
  busy = true;
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach((button) => { button.disabled = true; });
  try { await action(); } catch (err) { status.textContent = err.message; }
  finally {
    busy = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

$("server-settings").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    if (!server.reportValidity()) return;
    const serverUrl = server.value.trim();
    await browser.storage.local.set({ serverUrl });
    status.textContent = "Server URL updated.";
  });
});

$("create").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    if ((await readLocal()).wrappedKey || !server.reportValidity()) return;
    const pass = $("pass");
    if (!$("create").reportValidity()) return;
    const serverUrl = server.value.trim();
    const password = pass.value;
    const code = $("otc").value.trim();
    if (!code) throw new Error("Enter an invitation code from the admin.");
    status.textContent = "Creating library…";
    const created = await generatePrivateKey();
    try {
      await registerKey({ serverUrl, publicKey: created.publicKey, otc: code });
    } catch (err) {
      status.textContent = `Registration failed: ${err.message}. Check your invitation code and try again.`;
      return;
    }
    await saveWrappedKey({ serverUrl, privateKey: created.privateKey, passphrase: password });
    pass.value = "";
    $("otc").value = "";
    await refresh();
    status.textContent = "Library created. Download your recovery file before uploading.";
  });
});

$("backup").addEventListener("click", () => run(async () => {
  const blob = new Blob([recoveryFile(await readLocal())], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({ url, filename: "i2nclip-recovery.json", saveAs: true });
    status.textContent = "Recovery download started. Keep the file and your password somewhere safe.";
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}));

$("reset").addEventListener("click", () => run(async () => {
  if (!confirm("Reset everything in this browser? Keep a recovery file first. Uploads on the server will stay saved.")) return;
  await browser.storage.session.clear();
  await browser.storage.local.clear();
  document.querySelectorAll("form").forEach((form) => form.reset());
  await refresh();
  status.textContent = "Browser settings reset. Create a library or restore from a recovery file.";
}));

$("restore-settings").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    if ((await readLocal()).wrappedKey) return;
    const file = $("file").files?.[0];
    if (!file) throw new Error("Choose a recovery file first.");
    if (file.size > 16_384) throw new Error("Invalid recovery file.");
    const password = $("restore-pass").value;
    status.textContent = "Restoring library…";
    const recovered = parseRecoveryFile(await file.text());
    await restoreWrappedKey(recovered, password);
    $("restore-pass").value = "";
    $("file").value = "";
    await refresh();
    status.textContent = "Library restored and unlocked.";
  });
});
