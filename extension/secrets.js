// Profile storage holds the wrapped key. Session storage holds the plaintext
// only after a successful unlock, and Firefox drops that when it exits.
// The passphrase is never written.

import { unwrapPrivateKey, wrapPrivateKey } from "../client/vault.js";

const SESSION_KEY = "privateKey";

export const DEFAULT_SERVER_URL = "https://clip.example.com";

const MIN_PASSPHRASE_LENGTH = 8;

export async function saveWrappedKey({ serverUrl, privateKey, passphrase, authorizedLine }) {
  const trimmed = passphrase?.trim() ?? "";
  if (!trimmed) {
    throw new Error("Set a passphrase.");
  }
  if (trimmed.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const wrappedKey = await wrapPrivateKey(privateKey, trimmed);
  await browser.storage.local.set({ serverUrl, wrappedKey, authorizedLine });
  await browser.storage.session.set({ [SESSION_KEY]: privateKey });
}

export async function readLocal() {
  const stored = await browser.storage.local.get(["serverUrl", "wrappedKey", "authorizedLine"]);
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
    throw new Error("Set the private key in the extension options.");
  }
  const privateKey = await unwrapPrivateKey(wrappedKey, passphrase);
  await browser.storage.session.set({ [SESSION_KEY]: privateKey });
  return privateKey;
}
