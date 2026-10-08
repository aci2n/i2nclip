// Encrypt the OpenSSH private key before it is written to the Firefox profile.
// The passphrase is not an input we store. PBKDF2 turns it into an AES key,
// AES-GCM encrypts the key text, and a wrong passphrase fails the auth tag.

import { b64ToBytes, bytesToB64, utf8 } from "./bytes.js";

// OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Unlock takes a fraction of a
// second on purpose, so guessing the passphrase is slow.
export const PBKDF2_ITERATIONS = 600_000;

export async function wrapPrivateKey(privateKey, passphrase, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await wrappingKey(passphrase, salt, iterations);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(privateKey)),
  );
  return {
    v: 1,
    iterations,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(ct),
  };
}

export async function unwrapPrivateKey(wrapped, passphrase) {
  const key = await wrappingKey(passphrase, b64ToBytes(wrapped.salt), wrapped.iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(wrapped.iv) },
      key,
      b64ToBytes(wrapped.ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Wrong passphrase.");
  }
}

async function wrappingKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", utf8(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
