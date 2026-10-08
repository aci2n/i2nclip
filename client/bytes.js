// Small binary helpers. No dependencies, so this runs in Node and in Firefox.

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url without `=` padding. Safe inside a bearer token and a query string. */
export function bytesToB64url(bytes) {
  return bytesToB64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function b64urlToBytes(text) {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
  return b64ToBytes(padded);
}

export function concat(parts) {
  const n = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(n);
  let i = 0;
  for (const part of parts) {
    out.set(part, i);
    i += part.length;
  }
  return out;
}

export function utf8(text) {
  return new TextEncoder().encode(text);
}
