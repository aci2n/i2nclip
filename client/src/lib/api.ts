import { sniffContentType } from "./media/metadata.ts";
import { automaticTags } from "./media/tags.ts";
import { hexToBytes } from "./protocol/bytes.ts";
import type { LoadedKey } from "./protocol/crypto.ts";
import {
	authorizationHeader,
	bodyHash,
	contentAad,
	decrypt,
	encrypt,
	freshNonce,
	metaAad,
	tagTokens,
} from "./protocol/crypto.ts";
import { encodeMeta, encodeUpload } from "./protocol/frame.ts";
import type { Metadata } from "./protocol/meta-plain.ts";
import {
	decodeMetaPlain,
	encodeMetaPlain,
	MAX_META_PLAINTEXT,
} from "./protocol/meta-plain.ts";
import { CONTENT_TYPE, decode, encode } from "./protocol/msgpack.ts";
import { openTag, sealTags } from "./protocol/tag-labels.ts";
import { uniqueTags } from "./protocol/tags.ts";
import { bytes as binary, document, number, string } from "./protocol/value.ts";
export type Progress = (percent: number) => void;
export interface Credentials {
	serverUrl: string;
	key: LoadedKey;
}
interface RequestOptions extends Credentials {
	method: string;
	path: string;
	body: Uint8Array<ArrayBuffer>;
	onUploadProgress?: Progress;
	signal?: AbortSignal;
}
export interface UploadOptions extends Credentials {
	bytes: Uint8Array<ArrayBuffer>;
	name: string;
	contentType?: string;
	tags?: unknown;
	image?: Metadata["image"];
	extra?: Metadata;
	thumb?: Uint8Array<ArrayBuffer> | null;
	onProgress?: Progress;
	signal?: AbortSignal;
}
export interface Media {
	id: string;
	createdAt: number;
	bytes: number;
	metadata: Metadata | null;
	thumb: Uint8Array<ArrayBuffer> | null;
	metaHash: string;
}

// Each workflow depends on the capability it uses, not on the API module shape.
export interface AuthenticatedRequest extends Credentials {
	signal?: AbortSignal;
}
export interface ListRequest extends AuthenticatedRequest {
	tags?: string[] | string;
	after?: string | null;
}
export interface MediaRequest extends AuthenticatedRequest {
	id: string;
}
export interface ContentRequest extends MediaRequest {
	onProgress?: Progress;
}
export interface MetadataRequest extends MediaRequest {
	metadata: Metadata;
	thumb?: Uint8Array<ArrayBuffer> | null;
	prevMetaHash: string;
}
export interface RegistrationRequest extends AuthenticatedRequest {
	otc: string;
}
export interface MediaPage {
	items: Media[];
	next: string | null;
}
export interface Quota {
	used_content_bytes: number;
	max_content_bytes: number;
	file_count: number;
	max_files: number;
}
export interface TagCatalog {
	tags: string[];
	invalid: number;
}
export type MetadataResult =
	| { conflict: true; item: Media }
	| { conflict: false; metaHash: string };
export interface MediaApi {
	getContent(request: ContentRequest): Promise<Uint8Array<ArrayBuffer>>;
	updateMetadata(request: MetadataRequest): Promise<MetadataResult>;
	remove(request: MediaRequest): Promise<void>;
}
export interface ViewerApi extends Pick<MediaApi, "getContent"> {
	getMedia(request: MediaRequest): Promise<Media>;
}
export interface LibraryApi extends MediaApi {
	list(request: ListRequest): Promise<MediaPage>;
}
export interface IdentityApi {
	registerKey(request: RegistrationRequest): Promise<void>;
	isKeyRegistered(request: AuthenticatedRequest): Promise<boolean>;
}
export interface QuotaApi {
	getQuota(request: AuthenticatedRequest): Promise<Quota>;
}
export interface TagApi {
	getTags(request: AuthenticatedRequest): Promise<TagCatalog>;
}

// Browser HTTP calls.
// HTTP requests contain signatures and ciphertext, never the private key.

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
}: UploadOptions) {
	if (bytes.length > MAX_FILE_BYTES) {
		throw new Error("File is larger than 32 MB.");
	}
	const metadata = {
		...extra,
		name: cleanName(name),
		content_type: sniffContentType(bytes, contentType || ""),
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
	const body = encodeUpload({
		meta,
		content,
		tags: tokens,
	});
	const saved = await requestDocument({
		serverUrl,
		key,
		method: "POST",
		path: "/api/media",
		body,
		onUploadProgress: onProgress,
		signal,
	});
	return {
		...saved,
		id: string(saved.id),
		createdAt: number(saved.created_at),
		metadata,
		thumb: storedThumb,
		metaHash: await bodyHash(meta),
	};
}

export async function getTags({
	serverUrl,
	key,
	signal,
}: AuthenticatedRequest): Promise<TagCatalog> {
	const { tags } = await requestDocument({
		serverUrl,
		key,
		method: "GET",
		path: "/api/tags",
		body: new Uint8Array(),
		signal,
	});
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

export async function getQuota({
	serverUrl,
	key,
	signal,
}: AuthenticatedRequest): Promise<Quota> {
	const value = await requestDocument({
		serverUrl,
		key,
		method: "GET",
		path: "/api/quota",
		body: new Uint8Array(),
		signal,
	});
	return {
		used_content_bytes: number(value.used_content_bytes),
		max_content_bytes: number(value.max_content_bytes),
		file_count: number(value.file_count),
		max_files: number(value.max_files),
	};
}

export async function list({
	serverUrl,
	key,
	tags,
	after,
	signal,
}: ListRequest): Promise<MediaPage> {
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
	const page = await requestDocument({
		serverUrl,
		key,
		method: "GET",
		path,
		body: new Uint8Array(),
		signal,
	});
	const items = [];
	if (!Array.isArray(page.media)) {
		throw new Error("Invalid media list.");
	}
	for (const item of page.media) {
		items.push(await openMeta(key, item));
	}
	return { items, next: page.next ? string(page.next) : null };
}

export async function getMedia({
	serverUrl,
	key,
	id,
	signal,
}: MediaRequest): Promise<Media> {
	if (!/^[0-9a-f]{64}$/.test(id)) {
		throw new Error("Invalid media link.");
	}
	const response = await requestDocument({
		serverUrl,
		key,
		method: "GET",
		path: `/api/media/${id}/meta`,
		body: new Uint8Array(),
		signal,
	});
	const item = await openMeta(key, response);
	if (item.id !== id) {
		throw new Error("Invalid media response.");
	}
	return item;
}

export async function getContent({
	serverUrl,
	key,
	id,
	onProgress,
	signal,
}: ContentRequest) {
	const blob = await requestBytes({
		serverUrl,
		key,
		method: "GET",
		path: `/api/media/${id}`,
		body: new Uint8Array(),
		onDownloadProgress: onProgress,
		signal,
	});
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
}: MetadataRequest): Promise<MetadataResult> {
	const tokens = await sealTags(key, metadata.tags ?? []);
	const { meta } = await sealedMetadata(key, id, metadata, thumb);
	const body = encodeMeta({
		prevMetaHash: hexToBytes(prevMetaHash),
		meta,
		tags: tokens,
	});
	const response = await signedFetch({
		serverUrl,
		key,
		method: "PUT",
		path: `/api/media/${id}/meta`,
		body,
		signal,
	});
	if (response.status === 409) {
		let payload: Record<string, unknown> | undefined;
		try {
			payload = await responseDocument(response);
		} catch {}
		if (payload?.code === "metadata_conflict" && payload.media) {
			const item = await openMeta(key, payload.media);
			return {
				conflict: true as const,
				item,
			};
		}
		throw await responseError(response, payload);
	}
	if (!response.ok) {
		throw await responseError(response);
	}
	await responseDocument(response);
	return {
		conflict: false as const,
		metaHash: await bodyHash(meta),
	};
}

export async function remove({ serverUrl, key, id, signal }: MediaRequest) {
	await requestBytes({
		serverUrl,
		key,
		method: "DELETE",
		path: `/api/media/${id}`,
		body: new Uint8Array(),
		signal,
	});
}

/** Prove possession of the key being registered and spend an invitation. */
export async function registerKey({
	serverUrl,
	key,
	otc,
	signal,
}: RegistrationRequest) {
	const body = encode({ otc: String(otc).trim() });
	const response = await signedFetch({
		serverUrl,
		key,
		method: "POST",
		path: "/api/register-key",
		body,
		signal,
	});
	if (response.status === 204) {
		return;
	}
	throw await responseError(response);
}

// A signed read proves registration without spending another invitation.
export async function isKeyRegistered({
	serverUrl,
	key,
	signal,
}: AuthenticatedRequest) {
	const response = await signedFetch({
		serverUrl,
		key,
		method: "GET",
		path: "/api/ping",
		body: new Uint8Array(),
		signal,
	});
	if (response.status !== 204 && response.status !== 401) {
		throw await responseError(response);
	}
	await response.body?.cancel();
	return response.status === 204;
}

async function openMeta(key: LoadedKey, input: unknown): Promise<Media> {
	const item = document(input);
	const id = string(item.id);
	const createdAt = number(item.created_at);
	const size = number(item.bytes);
	const encrypted = binary(item.meta);
	const metaHash = await bodyHash(encrypted);
	try {
		const plain = await decrypt(key, metaAad(id), encrypted);
		const { metadata, thumb } = decodeMetaPlain(plain);
		return {
			id,
			createdAt,
			bytes: size,
			metadata,
			thumb,
			metaHash,
		};
	} catch {
		return {
			id,
			createdAt,
			bytes: size,
			metadata: null,
			thumb: null,
			metaHash,
		};
	}
}

async function requestDocument(request: RequestOptions) {
	const response = await signedFetch(request);
	if (response.status === 204) {
		return {};
	}
	if (!response.ok) {
		throw await responseError(response);
	}
	return responseDocument(response);
}

async function requestBytes({
	onDownloadProgress,
	...request
}: RequestOptions & { onDownloadProgress?: Progress }) {
	const response = await signedFetch(request);
	if (!response.ok) {
		throw await responseError(response);
	}
	return readBody(response, onDownloadProgress, request.signal);
}

async function sealedMetadata(
	key: LoadedKey,
	id: string,
	metadata: Metadata,
	thumb?: Uint8Array<ArrayBuffer> | null,
) {
	let storedThumb = thumb ?? null;
	let plain = encodeMetaPlain(metadata, storedThumb);
	if (plain.length > MAX_META_PLAINTEXT) {
		storedThumb = null;
		plain = encodeMetaPlain(metadata, null);
	}
	return { meta: await encrypt(key, metaAad(id), plain), storedThumb };
}

async function responseDocument(response: Response) {
	return document(decode(new Uint8Array(await response.arrayBuffer())));
}

async function responseError(
	response: Response,
	document?: Record<string, unknown>,
) {
	let message = response.statusText || `HTTP ${response.status}`;
	try {
		const payload = document ?? (await responseDocument(response));
		if (typeof payload.error === "string" && payload.error) {
			message = payload.error;
		}
	} catch {}
	const error = Object.assign(new Error(message), { status: response.status });
	return error;
}

async function readBody(
	response: Response,
	onProgress?: Progress,
	signal?: AbortSignal,
) {
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
				onProgress(Math.min(99, Math.round((received / total) * 100)));
			}
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	onProgress?.(100);
	signal?.throwIfAborted();
	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function signedFetch({
	serverUrl,
	key,
	method,
	path,
	body,
	onUploadProgress,
	signal,
}: RequestOptions) {
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
	if (onUploadProgress && payload && typeof XMLHttpRequest !== "undefined") {
		return requestWithProgress({
			method,
			url,
			headers,
			body: payload,
			onUploadProgress,
			signal,
		});
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

function requestWithProgress({
	method,
	url,
	headers,
	body,
	onUploadProgress,
	signal,
}: {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: Uint8Array<ArrayBuffer>;
	onUploadProgress: Progress;
	signal?: AbortSignal;
}) {
	return new Promise<Response>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const abort = () => xhr.abort();
		const finish = (action: () => void) => {
			signal?.removeEventListener("abort", abort);
			action();
		};
		xhr.open(method, url.href);
		xhr.responseType = "arraybuffer";
		for (const [name, value] of Object.entries(headers)) {
			xhr.setRequestHeader(name, value);
		}
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) {
				onUploadProgress(
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

function cleanName(name: string) {
	const base = String(name || "upload")
		.split(/[/\\]/)
		.pop()
		?.trim();
	return (base || "upload").slice(0, 200);
}
