// HTTP calls. `fetch` exists in Firefox extension pages, browsers, and Node.
// The private key never leaves this module except as a signature.

import { b64ToBytes, utf8 } from "./bytes.js";
import {
  authorizationHeader,
  contentAad,
  decrypt,
  encrypt,
  freshNonce,
  loadKey,
  metaAad,
  tagTokens,
} from "./crypto.js";
import { encodeMeta, encodePost } from "./frame.js";
import { decodeMetaPlain, encodeMetaPlain, MAX_META_PLAINTEXT } from "./meta-plain.js";
import { sniffContentType } from "./metadata.js";

// Plaintext limit. The server allows this plus a small encryption header.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

export async function upload({ serverUrl, privateKey, bytes, name, contentType, tags, id, image, thumb, onProgress }) {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error("File is larger than 32 MB.");
  }
  const key = await loadKey(privateKey);
  const mediaId = id ?? crypto.randomUUID();
  const plainTags = tagsToList(tags);
  const storedType = sniffContentType(bytes, contentType);
  const metadata = {
    name: cleanName(name),
    content_type: storedType,
    size: bytes.length,
    tags: plainTags,
  };
  if (image && Object.keys(image).length > 0) metadata.image = image;
  let metaPlain = encodeMetaPlain(metadata, thumb ?? null);
  if (metaPlain.length > MAX_META_PLAINTEXT) {
    metaPlain = encodeMetaPlain(metadata, null);
  }
  const meta = await encrypt(key, metaAad(mediaId), metaPlain);
  const content = await encrypt(key, contentAad(mediaId), bytes);
  const tokens = await tagTokens(key, plainTags);
  const body = encodePost({ id: mediaId, meta, content, tags: tokens.join("\n") });
  const saved = await send(serverUrl, key, "POST", "/api/media", body, onProgress);
  return { ...saved, metadata };
}

export async function list({ serverUrl, privateKey, tags, after }) {
  const key = await loadKey(privateKey);
  const tokens = tags ? await tagTokens(key, tags) : [];
  const params = new URLSearchParams();
  for (const token of tokens) params.append("tag", token);
  if (after) params.set("after", after);
  const query = params.toString();
  const path = query ? `/api/media?${query}` : "/api/media";
  const page = await send(serverUrl, key, "GET", path, new Uint8Array());
  const items = [];
  for (const item of page.media) {
    items.push({ ...(await openMeta(key, item)), tokens: item.tokens });
  }
  return { items, next: page.next || null };
}

export async function getContent({ serverUrl, privateKey, id, onProgress }) {
  const key = await loadKey(privateKey);
  const blob = await sendBytes(serverUrl, key, "GET", `/api/media/${id}`, new Uint8Array(), onProgress);
  return decrypt(key, contentAad(id), blob);
}

export async function updateMetadata({ serverUrl, privateKey, id, metadata, thumb }) {
  const key = await loadKey(privateKey);
  const tokens = await tagTokens(key, metadata.tags ?? []);
  let metaPlain = encodeMetaPlain(metadata, thumb ?? null);
  if (metaPlain.length > MAX_META_PLAINTEXT) {
    metaPlain = encodeMetaPlain(metadata, null);
  }
  const meta = await encrypt(key, metaAad(id), metaPlain);
  const body = encodeMeta({ meta, tags: tokens.join("\n") });
  return send(serverUrl, key, "PUT", `/api/media/${id}`, body);
}

export async function remove({ serverUrl, privateKey, id }) {
  const key = await loadKey(privateKey);
  await sendBytes(serverUrl, key, "DELETE", `/api/media/${id}`, new Uint8Array());
}

/** Register `authorizedLine` with a one-time code from the server admin. */
export async function registerKey({ serverUrl, authorizedLine, otc }) {
  const url = new URL("/api/register-key", serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      otc: String(otc).trim(),
      authorized_line: String(authorizedLine).trim(),
    }),
    cache: "no-store",
  });
  if (response.status === 204) return;
  const text = await response.text();
  let message = response.statusText;
  try {
    message = JSON.parse(text).error || message;
  } catch {
    message = text || message;
  }
  throw new Error(message);
}

async function openMeta(key, item) {
  try {
    const plain = await decrypt(key, metaAad(item.id), b64ToBytes(item.meta));
    const { metadata, thumb } = decodeMetaPlain(plain);
    return {
      id: item.id,
      createdAt: item.created_at,
      bytes: item.bytes,
      metadata,
      thumb,
    };
  } catch {
    return { id: item.id, createdAt: item.created_at, bytes: item.bytes, metadata: null, thumb: null };
  }
}

async function send(serverUrl, key, method, path, body, onProgress) {
  const response = await signedFetch(serverUrl, key, method, path, body, onProgress);
  if (response.status === 204) return null;
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(parsed?.error || response.statusText);
  }
  return parsed;
}

async function sendBytes(serverUrl, key, method, path, body, onProgress) {
  const response = await signedFetch(serverUrl, key, method, path, body);
  if (!response.ok) {
    const text = await response.text();
    let message = response.statusText;
    try {
      message = JSON.parse(text).error || message;
    } catch {
      message = text || message;
    }
    throw new Error(message);
  }
  return readBody(response, onProgress);
}

async function readBody(response, onProgress) {
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !onProgress || !total) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(100, Math.round((received / total) * 100)));
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function signedFetch(serverUrl, key, method, path, body, onProgress) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = freshNonce();
  const origin = new URL(serverUrl).origin;
  const authorization = await authorizationHeader({ key, origin, ts, nonce, method, path, body });
  const url = new URL(path, serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
  const headers = { authorization, "content-type": "application/octet-stream" };
  const payload = method === "GET" || method === "DELETE" ? undefined : body;
  // fetch() cannot report how much of the body has been sent. The upload
  // events on XMLHttpRequest can.
  if (onProgress && payload) return postUpload(url, headers, payload, onProgress);
  return fetch(url, {
    method,
    headers,
    body: payload,
    // A media id never changes, and that response allows a private cache.
    // Lists stay uncached because the server marks them no-store.
    cache: method === "GET" ? "default" : "no-store",
  });
}

function postUpload(url, headers, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        statusText: xhr.statusText,
        text: async () => xhr.responseText,
      });
    };
    xhr.onerror = () => reject(new Error("Upload failed."));
    xhr.send(body);
  });
}

function tagsToList(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  return String(tags)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function cleanName(name) {
  const base = String(name || "upload").split(/[/\\]/).pop().trim();
  return (base || "upload").slice(0, 200);
}
