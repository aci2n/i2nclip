import { generatePrivateKey, loadKey, registerKey } from "../client/index.js";
import { readLocal, saveWrappedKey } from "./secrets.js";

const server = document.querySelector("#server");
const key = document.querySelector("#key");
const pub = document.querySelector("#pub");
const status = document.querySelector("#status");
const pass = document.querySelector("#pass");
const pass2 = document.querySelector("#pass2");
const otc = document.querySelector("#otc");
const configured = document.querySelector("#configured");
const needsKey = document.querySelector("#needs-key");
const replace = document.querySelector("#replace");
const replaceSummary = document.querySelector("#replace-summary");

const saved = await readLocal();
server.value = saved.serverUrl || "";
pub.value = saved.authorizedLine || "";
refreshKeyState();

function hasStoredKey() {
  return Boolean(saved.wrappedKey);
}

function refreshKeyState() {
  if (hasStoredKey()) {
    configured.hidden = false;
    needsKey.hidden = true;
    replace.open = false;
    replaceSummary.textContent = "Replace the saved key";
  } else {
    configured.hidden = true;
    needsKey.hidden = false;
    replace.open = true;
    replaceSummary.textContent = "Create or import a key";
  }
}

document.querySelector("#save-server").addEventListener("click", async () => {
  if (!server.reportValidity()) return;
  const serverUrl = server.value.trim();
  await browser.storage.local.set({ serverUrl });
  status.textContent = "Server URL updated.";
});

document.querySelector("#generate").addEventListener("click", async () => {
  status.textContent = "Generating…";
  try {
    const created = await generatePrivateKey();
    key.value = created.privateKey;
    pub.value = created.authorizedLine;
    status.textContent = "Set a passphrase and save the key in Firefox, then register on the server.";
    pass.focus();
  } catch (err) {
    status.textContent = err.message;
  }
});

document.querySelector("#register-server").addEventListener("click", async () => {
  if (!server.reportValidity()) {
    status.textContent = "Set a valid server URL first.";
    server.focus();
    return;
  }
  const serverUrl = server.value.trim();
  await refreshPublicLine();
  if (!pub.value) {
    status.textContent = "Create or import a key first.";
    return;
  }
  const code = otc.value.trim();
  if (!code) {
    status.textContent = "Enter the one-time code from the admin.";
    otc.focus();
    return;
  }
  status.textContent = "Registering…";
  try {
    await registerKey({ serverUrl, authorizedLine: pub.value, otc: code });
    otc.value = "";
    status.textContent = hasStoredKey()
      ? "Public key registered on the server."
      : "Public key registered. Save the key in Firefox to use the library.";
  } catch (err) {
    status.textContent = err.message;
  }
});

document.querySelector("#copy").addEventListener("click", async () => {
  if (!pub.value) return;
  try {
    await navigator.clipboard.writeText(pub.value);
    status.textContent = "Public key copied.";
  } catch {
    pub.focus();
    pub.select();
    status.textContent = "Copy the public key from the box.";
  }
});

key.addEventListener("input", () => {
  refreshPublicLine();
});
document.querySelector("#file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  key.value = await file.text();
  await refreshPublicLine();
  if (pub.value) pass.focus();
});

document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const serverUrl = server.value.trim();
  const privateKey = key.value.trim();
  if (!server.reportValidity()) return;
  pass.required = true;
  pass2.required = true;
  pass.setCustomValidity(!pass.value.trim() ? "Set a passphrase." : "");
  pass2.setCustomValidity(pass.value === pass2.value ? "" : "The passphrases do not match.");
  if (!privateKey) {
    pass.setCustomValidity("");
    pass2.setCustomValidity("");
    status.textContent = "Paste or generate a private key first.";
    return;
  }
  if (!form.reportValidity()) return;
  await refreshPublicLine();
  if (!pub.value) return;
  status.textContent = "Encrypting…";
  try {
    await saveWrappedKey({
      serverUrl,
      privateKey,
      passphrase: pass.value,
      authorizedLine: pub.value,
    });
  } catch (err) {
    status.textContent = err.message;
    return;
  }
  saved.wrappedKey = true;
  key.value = "";
  pass.value = "";
  pass2.value = "";
  refreshKeyState();
  status.textContent = "Key saved in Firefox. The passphrase is not stored.";
});

async function refreshPublicLine() {
  if (!key.value.trim()) return;
  try {
    const loaded = await loadKey(key.value);
    pub.value = loaded.authorizedLine;
  } catch (err) {
    pub.value = saved.authorizedLine || "";
    status.textContent = err.message;
  }
}
