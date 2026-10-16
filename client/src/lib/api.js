// Browser HTTP calls.
// HTTP requests contain signatures and ciphertext, never the private key.

import { sniffContentType } from "./media/metadata.js";
import { automaticTags } from "./media/tags.js";
import { b64urlToBytes, hexToBytes } from "./protocol/bytes.js";
import {
	authorizationHeader,
	bodyHash,
	contentAad,
	decrypt,
	encrypt,
	freshNonce,
	metaAad,
	tagTokens,
} from "./protocol/crypto.js";
import { encodeMeta, encodePost } from "./protocol/frame.js";
import {
	decodeMetaPlain,
	encodeMetaPlain,
	MAX_META_PLAINTEXT,
} from "./protocol/meta-plain.js";
import { CONTENT_TYPE, decode, encode } from "./protocol/msgpack.js";
import { openTag, sealTags } from "./protocol/tag-labels.js";
import { uniqueTags } from "./protocol/tags.js";

// Plaintext limit. The server allows this plus a small encryption header.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENCRYPTED_FILE_BYTES = MAX_FILE_BYTES + 64;

export async function upload({
	serverUrl,
	key,
	bytes,
	name,
	contentType,
	tags,
	image,
	extra = {},
	thumb,
	onProgress,
	signal,
}) {
	if (bytes.length > MAX_FILE_BYTES) {
		throw new Error("File is larger than 32 MB.");
	}
	const metadata = {
		...extra,
		name: cleanName(name),
		content_type: sniffContentType(bytes, contentType),
		size: bytes.length,
		tags: uniqueTags(tags),
	};
	metadata.tags = uniqueTags([
		...metadata.tags,
		...automaticTags(metadata.name, metadata.content_type),
	]);
	if (image) {
		metadata.image = image;
	}
	const content = await encrypt(key, contentAad(), bytes);
	const mediaId = await bodyHash(content);
	const { meta, storedThumb } = await sealedMetadata(
		key,
		mediaId,
		metadata,
		thumb,
	);
	const tokens = await sealTags(key, metadata.tags);
	const body = encodePost({
		meta,
		content,
		tags: tokens,
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
	return {
		...saved,
		createdAt: saved.created_at,
		metadata,
		thumb: storedThumb,
		metaHash: await bodyHash(meta),
	};
}

export async function getTags({ serverUrl, key, signal }) {
	const { tags } = await send(
		serverUrl,
		key,
		"GET",
		"/api/tags",
		new Uint8Array(),
		undefined,
		signal,
	);
	if (!Array.isArray(tags)) {
		throw new Error("Invalid tag catalog.");
	}
	const labels = [];
	let invalid = 0;
	for (const entry of tags) {
		signal?.throwIfAborted();
		try {
			labels.push(await openTag(key, entry));
		} catch {
			invalid++;
		}
	}
	signal?.throwIfAborted();
	return {
		tags: uniqueTags(labels).sort((a, b) => a.localeCompare(b)),
		invalid,
	};
}

export async function getQuota({ serverUrl, key, signal }) {
	return send(
		serverUrl,
		key,
		"GET",
		"/api/quota",
		new Uint8Array(),
		undefined,
		signal,
	);
}

export async function list({ serverUrl, key, tags, after, signal }) {
	const tokens = tags ? await tagTokens(key, tags) : [];
	const params = new URLSearchParams();
	for (const token of tokens) {
		params.append("tag", token);
	}
	if (after) {
		params.set("after", after);
	}
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
		items.push(await openMeta(key, item));
	}
	return { items, next: page.next || null };
}

export async function getContent({ serverUrl, key, id, onProgress, signal }) {
	const blob = await sendBytes(
		serverUrl,
		key,
		"GET",
		`/api/media/${id}`,
		new Uint8Array(),
		onProgress,
		signal,
	);
	if ((await bodyHash(blob)) !== id) {
		throw new Error("Content hash mismatch.");
	}
	return decrypt(key, contentAad(), blob);
}

export async function updateMetadata({
	serverUrl,
	key,
	id,
	metadata,
	thumb,
	prevMetaHash,
	signal,
}) {
	const tokens = await sealTags(key, metadata.tags ?? []);
	const { meta } = await sealedMetadata(key, id, metadata, thumb);
	const body = encodeMeta({
		prevMetaHash: hexToBytes(prevMetaHash),
		meta,
		tags: tokens,
	});
	const response = await signedFetch(
		serverUrl,
		key,
		"PUT",
		`/api/media/${id}/meta`,
		body,
		undefined,
		signal,
	);
	if (response.status === 409) {
		const payload = await responseDocument(response);
		if (payload.code === "metadata_conflict" && payload.media) {
			const item = await openMeta(key, payload.media);
			return {
				conflict: true,
				item,
			};
		}
	}
	if (!response.ok) {
		throw await responseError(response);
	}
	await responseDocument(response);
	return {
		conflict: false,
		metaHash: await bodyHash(meta),
	};
}

export async function remove({ serverUrl, key, id, signal }) {
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
		headers: { "content-type": CONTENT_TYPE },
		body: encode({
			otc: String(otc).trim(),
			public_key: b64urlToBytes(String(publicKey).trim()),
		}),
		cache: "no-store",
		signal,
	});
	if (response.status === 204) {
		return;
	}
	throw await responseError(response);
}

// A signed read proves registration without spending another invitation.
export async function isKeyRegistered({ serverUrl, key, signal }) {
	const response = await signedFetch(
		serverUrl,
		key,
		"GET",
		"/api/ping",
		new Uint8Array(),
		undefined,
		signal,
	);
	if (response.status !== 204 && response.status !== 401) {
		throw await responseError(response);
	}
	await response.body?.cancel();
	return response.status === 204;
}

async function openMeta(key, item) {
	const encrypted = item.meta;
	const metaHash = await bodyHash(encrypted);
	try {
		const plain = await decrypt(key, metaAad(item.id), encrypted);
		const { metadata, thumb } = decodeMetaPlain(plain);
		return {
			id: item.id,
			createdAt: item.created_at,
			bytes: item.bytes,
			metadata,
			thumb,
			metaHash,
		};
	} catch {
		return {
			id: item.id,
			createdAt: item.created_at,
			bytes: item.bytes,
			metadata: null,
			thumb: null,
			metaHash,
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
	if (response.status === 204) {
		return null;
	}
	if (!response.ok) {
		throw await responseError(response);
	}
	return responseDocument(response);
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
	if (!response.ok) {
		throw await responseError(response);
	}
	return readBody(response, onProgress, signal);
}

async function sealedMetadata(key, id, metadata, thumb) {
	let storedThumb = thumb ?? null;
	let plain = encodeMetaPlain(metadata, storedThumb);
	if (plain.length > MAX_META_PLAINTEXT) {
		storedThumb = null;
		plain = encodeMetaPlain(metadata, null);
	}
	return { meta: await encrypt(key, metaAad(id), plain), storedThumb };
}

async function responseDocument(response) {
	return decode(new Uint8Array(await response.arrayBuffer()));
}

async function responseError(response) {
	let message = response.statusText || `HTTP ${response.status}`;
	try {
		const payload = await responseDocument(response);
		if (typeof payload.error === "string" && payload.error) {
			message = payload.error;
		}
	} catch {}
	const error = new Error(message);
	error.status = response.status;
	return error;
}

async function readBody(response, onProgress, signal) {
	const total = Number(response.headers.get("content-length")) || 0;
	if (total > MAX_ENCRYPTED_FILE_BYTES) {
		await response.body?.cancel();
		throw new Error("File is larger than 32 MB.");
	}
	if (!response.body) {
		return new Uint8Array();
	}
	const reader = response.body.getReader();
	const chunks = [];
	let received = 0;
	const abort = () => reader.cancel().catch(() => {});
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) {
				break;
			}
			received += value.length;
			if (received > MAX_ENCRYPTED_FILE_BYTES) {
				await reader.cancel();
				throw new Error("File is larger than 32 MB.");
			}
			chunks.push(value);
			if (onProgress && total) {
				onProgress(Math.min(100, Math.round((received / total) * 100)));
			}
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
	const headers = { authorization, "content-type": CONTENT_TYPE };
	const payload = method === "GET" || method === "DELETE" ? undefined : body;
	if (onProgress && payload && typeof XMLHttpRequest !== "undefined") {
		return requestWithProgress(
			method,
			url,
			headers,
			payload,
			onProgress,
			signal,
		);
	}
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
		xhr.responseType = "arraybuffer";
		for (const [name, value] of Object.entries(headers)) {
			xhr.setRequestHeader(name, value);
		}
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) {
				onProgress(
					Math.min(100, Math.round((event.loaded / event.total) * 100)),
				);
			}
		};
		xhr.onload = () =>
			finish(() => {
				try {
					resolve(
						new Response(xhr.status === 204 ? null : xhr.response, {
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
