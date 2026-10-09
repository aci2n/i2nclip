// Profile storage holds the wrapped key. Session storage holds the plaintext
// only after a successful unlock, and Firefox drops that when it exits.
// The passphrase is never written.

import { loadKey } from "../client/crypto.js";
import { unwrapPrivateKey, wrapPrivateKey } from "../client/vault.js";

const SESSION_KEY = "privateKey";

export const DEFAULT_SERVER_URL = "https://clip.i2n.duckdns.org";

const MIN_PASSPHRASE_LENGTH = 8;

export async function saveWrappedKey({ serverUrl, privateKey, passphrase }) {
  if (passphrase == null || passphrase === "") {
    throw new Error("Set an unlock password.");
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const loaded = await loadKey(privateKey);
  const wrappedKey = await wrapPrivateKey(privateKey, passphrase);
  await saveIdentity({ serverUrl, wrappedKey, publicKey: loaded.registrationKey }, privateKey);
}

export async function restoreWrappedKey(recovered, passphrase) {
  const { privateKey, loaded } = await openIdentity(recovered.wrappedKey, passphrase);
  await saveIdentity({ ...recovered, publicKey: loaded.registrationKey }, privateKey);
}

async function saveIdentity(settings, privateKey) {
  await browser.storage.local.set(settings);
  await browser.storage.session.set({ [SESSION_KEY]: privateKey });
}

async function openIdentity(wrappedKey, passphrase) {
  const privateKey = await unwrapPrivateKey(wrappedKey, passphrase);
  const loaded = await loadKey(privateKey);
  return { privateKey, loaded };
}

export async function readLocal() {
  const stored = await browser.storage.local.get(["serverUrl", "wrappedKey", "publicKey"]);
  return { ...stored, serverUrl: stored.serverUrl || DEFAULT_SERVER_URL };
}

export async function sessionPrivateKey() {
  const stored = await browser.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || "";
}

export function bindUnlock(form, status, done) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "Checking…";
    try {
      const pass = form.querySelector('input[type="password"]');
      const privateKey = await unlock(pass.value);
      pass.value = "";
      await done(privateKey);
    } catch (err) {
      status.textContent = err.message;
    }
  });
}

export async function unlock(passphrase) {
  const { wrappedKey } = await browser.storage.local.get("wrappedKey");
  if (!wrappedKey) {
    throw new Error("Create or restore your library in the extension settings.");
  }
  const { privateKey } = await openIdentity(wrappedKey, passphrase);
  await browser.storage.session.set({ [SESSION_KEY]: privateKey });
  return privateKey;
}
