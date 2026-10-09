// HTTP calls. `fetch` exists in Firefox extension pages, browsers, and Node.
// HTTP requests contain signatures and ciphertext, never the private key.

import { b64ToBytes } from "./bytes.js";
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
import {
	decodeMetaPlain,
	encodeMetaPlain,
	MAX_META_PLAINTEXT,
} from "./meta-plain.js";
import { sniffContentType } from "./metadata.js";
import { uniqueTags } from "./tags.js";

// Plaintext limit. The server allows this plus a small encryption header.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENCRYPTED_FILE_BYTES = MAX_FILE_BYTES + 64;

export async function upload({
	serverUrl,
	privateKey,
	bytes,
	name,
	contentType,
	tags,
	id,
	image,
	thumb,
	onProgress,
	signal,
}) {
	if (bytes.length > MAX_FILE_BYTES) {
		throw new Error("File is larger than 32 MB.");
	}
	const key = await loadKey(privateKey);
	const mediaId = id ?? crypto.randomUUID();
	const plainTags = uniqueTags(tags);
	const storedType = sniffContentType(bytes, contentType);
	const metadata = {
		name: cleanName(name),
		content_type: storedType,
		size: bytes.length,
		tags: plainTags,
	};
	if (image && Object.keys(image).length > 0) metadata.image = image;
	const meta = await sealedMetadata(key, mediaId, metadata, thumb);
	const content = await encrypt(key, contentAad(mediaId), bytes);
	const tokens = await tagTokens(key, plainTags);
	const body = encodePost({
		id: mediaId,
		meta,
		content,
		tags: tokens.join("\n"),
	});
	const saved = await send(
		serverUrl,
		key,
		"POST",
		"/api/media",
		body,
		onProgress,
		signal,
	);
	return { ...saved, metadata };
}

export async function list({ serverUrl, privateKey, tags, after, signal }) {
	const key = await loadKey(privateKey);
	const tokens = tags ? await tagTokens(key, tags) : [];
	const params = new URLSearchParams();
	for (const token of tokens) params.append("tag", token);
	if (after) params.set("after", after);
	const query = params.toString();
	const path = query ? `/api/media?${query}` : "/api/media";
	const page = await send(
		serverUrl,
		key,
		"GET",
		path,
		new Uint8Array(),
		undefined,
		signal,
	);
	const items = [];
	for (const item of page.media) {
		items.push({ ...(await openMeta(key, item)), tokens: item.tokens });
	}
	return { items, next: page.next || null };
}

export async function getContent({
	serverUrl,
	privateKey,
	id,
	onProgress,
	signal,
}) {
	const key = await loadKey(privateKey);
	const blob = await sendBytes(
		serverUrl,
		key,
		"GET",
		`/api/media/${id}`,
		new Uint8Array(),
		onProgress,
		signal,
	);
	return decrypt(key, contentAad(id), blob);
}

export async function updateMetadata({
	serverUrl,
	privateKey,
	id,
	metadata,
	thumb,
	signal,
}) {
	const key = await loadKey(privateKey);
	const tokens = await tagTokens(key, metadata.tags ?? []);
	const meta = await sealedMetadata(key, id, metadata, thumb);
	const body = encodeMeta({ meta, tags: tokens.join("\n") });
	return send(
		serverUrl,
		key,
		"PUT",
		`/api/media/${id}`,
		body,
		undefined,
		signal,
	);
}

export async function remove({ serverUrl, privateKey, id, signal }) {
	const key = await loadKey(privateKey);
	await sendBytes(
		serverUrl,
		key,
		"DELETE",
		`/api/media/${id}`,
		new Uint8Array(),
		undefined,
		signal,
	);
}

/** Register a base64url public key with an invitation code. */
export async function registerKey({ serverUrl, publicKey, otc, signal }) {
	const url = new URL("/api/register-key", serverUrl);
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			otc: String(otc).trim(),
			public_key: String(publicKey).trim(),
		}),
		cache: "no-store",
		signal,
	});
	if (response.status === 204) return;
	throw await responseError(response);
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
		return {
			id: item.id,
			createdAt: item.created_at,
			bytes: item.bytes,
			metadata: null,
			thumb: null,
		};
	}
}

async function send(serverUrl, key, method, path, body, onProgress, signal) {
	const response = await signedFetch(
		serverUrl,
		key,
		method,
		path,
		body,
		onProgress,
		signal,
	);
	if (response.status === 204) return null;
	if (!response.ok) throw await responseError(response);
	return response.json();
}

async function sendBytes(
	serverUrl,
	key,
	method,
	path,
	body,
	onProgress,
	signal,
) {
	const response = await signedFetch(
		serverUrl,
		key,
		method,
		path,
		body,
		undefined,
		signal,
	);
	if (!response.ok) throw await responseError(response);
	return readBody(response, onProgress, signal);
}

async function sealedMetadata(key, id, metadata, thumb) {
	let plain = encodeMetaPlain(metadata, thumb ?? null);
	if (plain.length > MAX_META_PLAINTEXT)
		plain = encodeMetaPlain(metadata, null);
	return encrypt(key, metaAad(id), plain);
}

async function responseError(response) {
	const text = await response.text();
	let message = text || response.statusText;
	try {
		message = JSON.parse(text).error || response.statusText;
	} catch {}
	return new Error(message);
}

async function readBody(response, onProgress, signal) {
	const total = Number(response.headers.get("content-length")) || 0;
	if (total > MAX_ENCRYPTED_FILE_BYTES) {
		await response.body?.cancel();
		throw new Error("File is larger than 32 MB.");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks = [];
	let received = 0;
	const abort = () => reader.cancel();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			received += value.length;
			if (received > MAX_ENCRYPTED_FILE_BYTES) {
				await reader.cancel();
				throw new Error("File is larger than 32 MB.");
			}
			chunks.push(value);
			if (onProgress && total)
				onProgress(Math.min(100, Math.round((received / total) * 100)));
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function signedFetch(
	serverUrl,
	key,
	method,
	path,
	body,
	onProgress,
	signal,
) {
	const ts = Math.floor(Date.now() / 1000);
	const nonce = freshNonce();
	const origin = new URL(serverUrl).origin;
	const authorization = await authorizationHeader({
		key,
		origin,
		ts,
		nonce,
		method,
		path,
		body,
	});
	signal?.throwIfAborted();
	const url = new URL(path, serverUrl);
	const headers = { authorization, "content-type": "application/octet-stream" };
	const payload = method === "GET" || method === "DELETE" ? undefined : body;
	// fetch() cannot report how much of the body has been sent. The upload
	// events on XMLHttpRequest can.
	if (onProgress && payload)
		return requestWithProgress(
			method,
			url,
			headers,
			payload,
			onProgress,
			signal,
		);
	return fetch(url, {
		method,
		headers,
		signal,
		body: payload,
		// A media id never changes, and that response allows a private cache.
		// Lists stay uncached because the server marks them no-store.
		cache: method === "GET" ? "default" : "no-store",
	});
}

function requestWithProgress(method, url, headers, body, onProgress, signal) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const abort = () => xhr.abort();
		const finish = (action) => {
			signal?.removeEventListener("abort", abort);
			action();
		};
		xhr.open(method, url);
		for (const [name, value] of Object.entries(headers))
			xhr.setRequestHeader(name, value);
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable)
				onProgress(
					Math.min(100, Math.round((event.loaded / event.total) * 100)),
				);
		};
		xhr.onload = () =>
			finish(() => {
				try {
					resolve(
						new Response(xhr.status === 204 ? null : xhr.responseText, {
							status: xhr.status,
							statusText: xhr.statusText,
						}),
					);
				} catch (error) {
					reject(error);
				}
			});
		xhr.onerror = () => finish(() => reject(new Error("Upload failed.")));
		xhr.onabort = () =>
			finish(() =>
				reject(new DOMException("Request cancelled.", "AbortError")),
			);
		signal?.throwIfAborted();
		signal?.addEventListener("abort", abort, { once: true });
		xhr.send(body);
	});
}

function cleanName(name) {
	const base = String(name || "upload")
		.split(/[/\\]/)
		.pop()
		.trim();
	return (base || "upload").slice(0, 200);
}
