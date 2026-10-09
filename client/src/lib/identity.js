// Internal identity document. Recovery files encrypt this entire document.
import { b64urlToBytes, bytesToB64url } from "./bytes.js";

export function parsePrivateKey(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid library identity."); }
  if (value?.v !== 1 || typeof value.seed !== "string" || typeof value.publicKey !== "string") {
    throw new Error("Invalid library identity.");
  }
  const seed = decodeKey(value.seed);
  const publicKey = decodeKey(value.publicKey);
  return { seed, publicKey };
}

function decodeKey(text) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new Error("Invalid library identity.");
  const bytes = b64urlToBytes(text);
  if (bytes.length !== 32 || bytesToB64url(bytes) !== text) throw new Error("Invalid library identity.");
  return bytes;
}

export async function generatePrivateKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const privateKey = JSON.stringify({ v: 1, seed: jwk.d, publicKey: jwk.x });
  parsePrivateKey(privateKey);
  return { privateKey, publicKey: jwk.x };
}
