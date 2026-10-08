// Read and write an unencrypted OpenSSH Ed25519 private key, the same text
// `ssh-keygen -t ed25519 -N ''` uses. A generated key has no passphrase of
// its own. The extension wraps that text with the user's passphrase before
// saving it.
//
// The text looks like:
//
//   -----BEGIN OPENSSH PRIVATE KEY-----
//   AAA...
//   -----END OPENSSH PRIVATE KEY-----
//
// After base64-decoding, the bytes are the format in OpenSSH's PROTOCOL.key
// document. Lengths are big-endian uint32s, the same layout as the public key.

import { b64ToBytes, b64urlToBytes, bytesToB64, bytesToHex, concat, utf8 } from "./bytes.js";

const MAGIC = utf8("openssh-key-v1\0");

/**
 * @param {string} text whole private key file
 * @returns {{ seed: Uint8Array, publicKey: Uint8Array }}
 */
export function parsePrivateKey(text) {
  const compact = text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("-----"))
    .join("")
    .replace(/\s+/g, "");
  const bytes = b64ToBytes(compact);
  if (!startsWith(bytes, MAGIC)) {
    throw new Error("not an OpenSSH private key from ssh-keygen");
  }
  const cur = cursor(bytes.subarray(MAGIC.length));
  const cipher = decode(cur.sshString());
  const kdf = decode(cur.sshString());
  cur.sshString();
  if (cipher !== "none" || kdf !== "none") {
    throw new Error(
      "this OpenSSH key has a passphrase. Create one with: ssh-keygen -t ed25519 -N ''",
    );
  }
  if (cur.u32() !== 1) {
    throw new Error("OpenSSH key must contain one key");
  }
  const publicKey = parsePublicBlob(cur.sshString());
  const section = cur.sshString();
  if (cur.rest() !== 0) {
    throw new Error("trailing data in OpenSSH private key");
  }
  const seed = seedFromSection(section, publicKey);
  return { seed, publicKey };
}

function seedFromSection(section, publicKey) {
  const cur = cursor(section);
  const checkA = cur.u32();
  const checkB = cur.u32();
  if (checkA !== checkB) {
    throw new Error("OpenSSH private key checksum does not match");
  }
  if (decode(cur.sshString()) !== "ssh-ed25519") {
    throw new Error("OpenSSH private key is not ssh-ed25519");
  }
  // Raw 32-byte public key. The outer blob is the wrapped form.
  const inner = cur.sshString();
  const secret = cur.sshString();
  cur.sshString();
  let pad = 1;
  const rest = cur.takeRest();
  for (const byte of rest) {
    if (byte !== pad) {
      throw new Error("OpenSSH private key padding is wrong");
    }
    pad = (pad + 1) & 0xff;
  }
  if (
    inner.length !== 32 ||
    secret.length !== 64 ||
    bytesToHex(inner) !== bytesToHex(publicKey) ||
    bytesToHex(secret.subarray(32)) !== bytesToHex(publicKey)
  ) {
    throw new Error("OpenSSH private key does not match its public key");
  }
  return secret.subarray(0, 32);
}

/** `ssh-ed25519` wire blob -> 32-byte public key. */
export function parsePublicBlob(blob) {
  const cur = cursor(blob);
  if (decode(cur.sshString()) !== "ssh-ed25519") {
    throw new Error("not an ssh-ed25519 public key");
  }
  const key = cur.sshString();
  if (key.length !== 32 || cur.rest() !== 0) {
    throw new Error("not an ssh-ed25519 public key");
  }
  return key;
}

/** New Ed25519 key, encoded as an OpenSSH private key plus the public line. */
export async function generatePrivateKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const seed = b64urlToBytes(jwk.d);
  const publicKey = b64urlToBytes(jwk.x);
  if (seed.length !== 32 || publicKey.length !== 32) {
    throw new Error("could not generate an Ed25519 key");
  }
  return {
    privateKey: encodeOpenSSH(seed, publicKey, "i2nclip"),
    authorizedLine: authorizedLine(publicKey),
  };
}

function encodeOpenSSH(seed, publicKey, comment) {
  const publicBlob = concat([sshString(utf8("ssh-ed25519")), sshString(publicKey)]);
  const secret = concat([seed, publicKey]);
  let section = concat([
    u32(0x0a0b0c0d),
    u32(0x0a0b0c0d),
    sshString(utf8("ssh-ed25519")),
    sshString(publicKey),
    sshString(secret),
    sshString(utf8(comment)),
  ]);
  const padding = [];
  let pad = 1;
  while ((section.length + padding.length) % 8 !== 0) {
    padding.push(pad);
    pad += 1;
  }
  section = concat([section, new Uint8Array(padding)]);
  const outer = concat([
    MAGIC,
    sshString(utf8("none")),
    sshString(utf8("none")),
    sshString(new Uint8Array()),
    u32(1),
    sshString(publicBlob),
    sshString(section),
  ]);
  const b64 = bytesToB64(outer);
  const lines = b64.match(/.{1,70}/g).join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function authorizedLine(publicKey) {
  const parts = [sshString(utf8("ssh-ed25519")), sshString(publicKey)];
  return `ssh-ed25519 ${bytesToB64(concat(parts))} i2nclip`;
}

function cursor(data) {
  let i = 0;
  return {
    u32() {
      const view = new DataView(data.buffer, data.byteOffset + i, 4);
      i += 4;
      return view.getUint32(0);
    },
    sshString() {
      const n = this.u32();
      const out = data.subarray(i, i + n);
      i += n;
      if (out.length !== n) {
        throw new Error("truncated OpenSSH private key");
      }
      return out;
    },
    rest() {
      return data.length - i;
    },
    takeRest() {
      const out = data.subarray(i);
      i = data.length;
      return out;
    },
  };
}

function sshString(data) {
  const out = new Uint8Array(4 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

function decode(bytes) {
  return new TextDecoder().decode(bytes);
}

function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}
