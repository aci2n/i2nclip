import assert from "node:assert/strict";
import test from "node:test";
import {
	getContent,
	getQuota,
	isKeyRegistered,
	list,
	MAX_FILE_BYTES,
	registerKey,
	remove,
	updateMetadata,
	upload,
} from "../src/lib/api.ts";
import { hexToBytes } from "../src/lib/protocol/bytes.ts";
import {
	authorizationHeader,
	bodyHash,
	contentAad,
	decrypt,
	encrypt,
	loadKey,
	metaAad,
} from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import {
	decodeMetaPlain,
	encodeMetaPlain,
} from "../src/lib/protocol/meta-plain.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import { bytes as binary, document } from "../src/lib/protocol/value.ts";
import { assertPresent } from "./assert.ts";
import { requestBody, requestDocument } from "./helpers.ts";
import { documentResponse } from "./msgpack-response.ts";

test("registration checks use a signed empty ping, distinguish unauthorized keys and propagate server failures", async (t) => {
	const key = await generatePrivateKey();
	let status = 204;
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, options: RequestInit = {}) => {
			assert.equal(String(url), "https://clip.example/api/ping");
			assert.equal(options.method, "GET");
			assert(assertPresent(new Headers(options.headers).get("authorization")));
			assert.equal(options.body, undefined);
			return status === 503
				? documentResponse({ error: "unavailable" }, { status })
				: new Response(null, { status });
		},
	);
	const credentials = {
		serverUrl: "https://clip.example",
		key: await loadKey(key.privateKey),
	};
	assert.equal(await isKeyRegistered(credentials), true);
	status = 401;
	assert.equal(await isKeyRegistered(credentials), false);
	status = 503;
	await assert.rejects(
		isKeyRegistered(credentials),
		(error) =>
			error instanceof Error && "status" in error && error.status === 503,
	);
});
for (const [body, contentType, message] of [
	[
		encode({ error: "permission denied" }),
		"application/msgpack",
		"permission denied",
	],
	["upstream unavailable", "text/plain", "Service Unavailable"],
	["", "text/plain", "Service Unavailable"],
] as const) {
	test(`API errors are consistent across endpoints: ${message}`, async (t) => {
		const { privateKey } = await generatePrivateKey();
		t.mock.method(
			globalThis,
			"fetch",
			async () =>
				new Response(body, {
					status: 503,
					statusText: "Service Unavailable",
					headers: { "content-type": contentType },
				}),
		);
		const settings = {
			serverUrl: "https://clip.example.com",
			key: await loadKey(privateKey),
			id: "test",
		};
		for (const request of [
			() => registerKey({ ...settings, otc: "test" }),
			() => list(settings),
			() => getContent(settings),
			() => remove(settings),
		]) {
			await assert.rejects(
				request,
				(error) => error instanceof Error && error.message === message,
			);
		}
	});
}
test("upload progress uses the same response handling as fetch", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const requests: {
		method: string;
		url: string;
	}[] = [];
	const original = globalThis.XMLHttpRequest;
	t.after(() => {
		if (original === undefined) {
			Reflect.deleteProperty(globalThis, "XMLHttpRequest");
		} else {
			globalThis.XMLHttpRequest = original;
		}
	});
	Object.defineProperty(globalThis, "XMLHttpRequest", {
		configurable: true,
		writable: true,
		value: class {
			upload: {
				onprogress?: (event: {
					lengthComputable: boolean;
					loaded: number;
					total: number;
				}) => void;
			} = {};
			onload?: () => void;
			status = 201;
			statusText = "Created";
			response = encode({ id: "saved", created_at: 1 }).slice().buffer;
			open(method: string, url: string) {
				requests.push({ method, url: String(url) });
			}
			setRequestHeader() {}
			send(body: Uint8Array) {
				assertPresent(this.upload.onprogress)({
					lengthComputable: true,
					loaded: body.length,
					total: body.length,
				});
				assertPresent(this.onload)();
			}
		},
	});
	const progress: Array<number> = [];
	const result = await upload({
		serverUrl: "https://clip.example.com",
		key: await loadKey(privateKey),
		bytes: new Uint8Array([1, 2, 3]),
		name: "sample.bin",
		tags: [" Vacation, dog ", "Cat"],
		extra: {
			name: "ignored",
			source_url: "https://example.com/page",
			source_title: "A page",
		},
		onProgress: (percent) => progress.push(percent),
	});
	assert.equal(result.id, "saved");
	assert.equal(result.metadata.name, "sample.bin");
	assert.equal(result.metadata.source_url, "https://example.com/page");
	assert.equal(result.metadata.source_title, "A page");
	assert.deepEqual(result.metadata.tags, [
		"Vacation",
		"dog",
		"Cat",
		"file",
		"bin",
		"sample",
	]);
	assert.deepEqual(progress, [100]);
	assert.deepEqual(requests, [
		{ method: "POST", url: "https://clip.example.com/api/media" },
	]);
});
test("downloaded encrypted content is capped before buffering", async (t) => {
	const { privateKey } = await generatePrivateKey();
	let cancelled = false;
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{ headers: { "content-length": String(MAX_FILE_BYTES + 65) } },
			),
	);
	await assert.rejects(
		getContent({
			serverUrl: "https://clip.example.com",
			key: await loadKey(privateKey),
			id: "test",
		}),
		/larger than 32 MB/,
	);
	assert.equal(cancelled, true);
});
test("reencrypting an upload uses fresh sealed content after a lost response", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const bodies: Array<Uint8Array<ArrayBuffer>> = [];
	const contentOf = (body: Uint8Array<ArrayBufferLike>) =>
		binary(document(decode(body)).content);
	t.mock.method(
		globalThis,
		"fetch",
		async (_url: string | URL | Request, options: RequestInit = {}) => {
			bodies.push(requestBody(options));
			if (bodies.length === 1) {
				throw new Error("lost response");
			}
			return new Response(
				encode({
					id: await bodyHash(contentOf(requestBody(options))),
					created_at: 1,
				}),
				{ status: 201 },
			);
		},
	);
	const options = {
		serverUrl: "https://clip.example",
		key: await loadKey(privateKey),
		bytes: new Uint8Array([1]),
		name: "file",
		tags: [],
	};
	await assert.rejects(upload(options), /lost response/);
	const saved = await upload(options);
	assert.equal(saved.id, await bodyHash(contentOf(bodies[1])));
	assert.equal(bodies.length, 2);
	assert.notDeepEqual(contentOf(bodies[0]), contentOf(bodies[1]));
});
test("content hashes are checked before decryption", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const key = await loadKey(privateKey);
	const plain = new Uint8Array([1, 2, 3]);
	const content = await encrypt(key, contentAad(), plain);
	t.mock.method(globalThis, "fetch", async () => new Response(content));
	const options = { serverUrl: "https://clip.example", key };
	await assert.rejects(
		getContent({ ...options, id: "0".repeat(64) }),
		/Content hash mismatch/,
	);
	assert.deepEqual(
		await getContent({ ...options, id: await bodyHash(content) }),
		plain,
	);
});
test("metadata list and update sign their routes and preserve decrypted fields", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const key = await loadKey(privateKey);
	const id = "a".repeat(64);
	const metadata = {
		name: "photo",
		source_url: "https://example.com/photo",
		source_title: "Photo source",
		content_type: "image/png",
		tags: ["One"],
		size: 3,
	};
	const thumb = new Uint8Array([1, 2, 3]);
	const renamed = { ...metadata, name: "Renamed photo — Córdoba.png" };
	const meta = await encrypt(
		key,
		metaAad(id),
		encodeMetaPlain(metadata, thumb),
	);
	const controller = new AbortController();
	const methods: Array<string | undefined> = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, options: RequestInit = {}) => {
			const path =
				options.method === "GET" ? "/api/media" : `/api/media/${id}/meta`;
			assert.equal(String(url), `https://clip.example${path}`);
			assert.equal(options.signal, controller.signal);
			const [, ts, nonce] = assertPresent(
				new Headers(options.headers).get("authorization"),
			)
				.slice(7)
				.split(".");
			assert.equal(
				assertPresent(new Headers(options.headers).get("authorization")),
				await authorizationHeader({
					key,
					origin: "https://clip.example",
					ts: Number(ts),
					nonce,
					method: assertPresent(options.method),
					path,
					body: options.body ? requestBody(options) : new Uint8Array(),
				}),
			);
			methods.push(options.method);
			if (options.method === "PUT") {
				const body = requestBody(options);
				const packet = document(decode(body));
				assert.deepEqual(
					binary(packet.prev_meta_hash),
					hexToBytes(await bodyHash(meta)),
				);
				const sealed = binary(packet.meta);
				assert.deepEqual(
					decodeMetaPlain(await decrypt(key, metaAad(id), sealed)),
					{ metadata: renamed, thumb },
				);
				assert(!new TextDecoder().decode(body).includes(renamed.name));
			}
			const item = {
				id,
				created_at: 123,
				bytes: 32,
				meta,
			};
			return documentResponse(
				options.method === "GET" ? { media: [item], next: null } : item,
			);
		},
	);
	const credentials = {
		serverUrl: "https://clip.example",
		key: await loadKey(privateKey),
		id,
		signal: controller.signal,
	};
	const {
		items: [item],
	} = await list(credentials);
	assert.deepEqual(item, {
		id,
		createdAt: 123,
		bytes: 32,
		metadata,
		thumb,
		metaHash: await bodyHash(meta),
	});
	const saved = await updateMetadata({
		...credentials,
		metadata: renamed,
		thumb,
		prevMetaHash: item.metaHash,
	});
	assert.equal(saved.conflict, false);
	assert.deepEqual(methods, ["GET", "PUT"]);
	controller.abort();
	await assert.rejects(list(credentials), { name: "AbortError" });
	assert.deepEqual(methods, ["GET", "PUT"]);
});
test("undecryptable metadata is returned without an editable payload", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const meta = new Uint8Array(29);
	meta[0] = 1;
	t.mock.method(globalThis, "fetch", async () =>
		documentResponse({
			media: [
				{
					id: "a".repeat(64),
					created_at: 1,
					bytes: 1,
					meta,
				},
			],
			next: null,
		}),
	);
	const {
		items: [item],
	} = await list({
		serverUrl: "https://clip.example",
		key: await loadKey(privateKey),
	});
	assert.equal(item.metadata, null);
	assert.equal(item.thumb, null);
	assert.equal(item.metaHash, await bodyHash(meta));
});
test("Node uploads with progress callbacks fall back to fetch", async (t) => {
	const { privateKey } = await generatePrivateKey();
	assert.equal(typeof XMLHttpRequest, "undefined");
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return documentResponse({ id: "saved", created_at: 1 }, { status: 201 });
	});
	await upload({
		serverUrl: "https://clip.example",
		key: await loadKey(privateKey),
		bytes: new Uint8Array([1]),
		name: "file",
		tags: [],
		onProgress: () => {
			throw new Error("fetch cannot report upload progress");
		},
	});
	assert.equal(calls, 1);
});
test("HTTP failures expose status without changing their error message", async (t) => {
	const { privateKey } = await generatePrivateKey();
	t.mock.method(globalThis, "fetch", async () =>
		documentResponse({ error: "not found" }, { status: 404 }),
	);
	await assert.rejects(
		list({
			serverUrl: "https://clip.example",
			key: await loadKey(privateKey),
		}),
		(error) =>
			error instanceof Error &&
			"status" in error &&
			error.status === 404 &&
			error.message === "not found",
	);
});
test("quota uses a signed empty GET and carries cancellation", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const controller = new AbortController();
	const usage = {
		max_content_bytes: 536870912,
		max_files: 10000,
		used_content_bytes: 0,
		file_count: 0,
	};
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, options: RequestInit = {}) => {
			assert.equal(String(url), "https://clip.example/api/quota");
			assert.equal(options.method, "GET");
			assert.equal(options.body, undefined);
			assert(
				assertPresent(
					new Headers(options.headers).get("authorization"),
				).startsWith("Bearer "),
			);
			assert.equal(options.signal, controller.signal);
			return documentResponse(usage);
		},
	);
	assert.deepEqual(
		await getQuota({
			serverUrl: "https://clip.example",
			key: await loadKey(privateKey),
			signal: controller.signal,
		}),
		usage,
	);
});
test("canceling a streaming download stops its reader without unhandled cancellation failures", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const controller = new AbortController();
	let canceled = false;
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					start(stream) {
						stream.enqueue(new Uint8Array([1]));
					},
					cancel() {
						canceled = true;
						return Promise.reject(new Error("stream already failed"));
					},
				}),
				{ headers: { "content-length": "100" } },
			),
	);
	await assert.rejects(
		getContent({
			serverUrl: "https://clip.example",
			key: await loadKey(privateKey),
			id: "a".repeat(64),
			signal: controller.signal,
			onProgress: () => controller.abort(),
		}),
		{ name: "AbortError" },
	);
	assert.equal(canceled, true);
});
test("metadata conflicts preserve ordinary errors and HTTP fallback", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const key = await loadKey(privateKey);
	let response = documentResponse(
		{ error: "Library storage limit reached." },
		{ status: 409 },
	);
	t.mock.method(globalThis, "fetch", async () => response);
	const options = {
		serverUrl: "https://clip.example",
		key,
		id: "a".repeat(64),
		prevMetaHash: "0".repeat(64),
		metadata: { name: "x", tags: [] },
	};
	await assert.rejects(updateMetadata(options), {
		message: "Library storage limit reached.",
		status: 409,
	});
	response = new Response("upstream", { status: 409, statusText: "Conflict" });
	await assert.rejects(updateMetadata(options), {
		message: "Conflict",
		status: 409,
	});
});
test("registration signs the otc-only body with the unregistered key", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const key = await loadKey(privateKey);
	const controller = new AbortController();
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, options: RequestInit = {}) => {
			assert.equal(String(url), "https://clip.example/api/register-key");
			assert.equal(options.method, "POST");
			assert.equal(
				new Headers(options.headers).get("content-type"),
				"application/msgpack",
			);
			assert.equal(options.signal, controller.signal);
			assert.deepEqual(requestDocument(options), {
				otc: "invitation",
			});
			const [publicKey, ts, nonce, hash, signature] = assertPresent(
				new Headers(options.headers).get("authorization"),
			)
				.slice(7)
				.split(".");
			assert.equal(publicKey, key.registrationKey);
			assert.equal(hash, await bodyHash(requestBody(options)));
			const { b64urlToBytes } = await import("../src/lib/protocol/bytes.ts");
			const { requestMessage } = await import("../src/lib/protocol/crypto.ts");
			const verifying = await crypto.subtle.importKey(
				"raw",
				key.publicKey,
				"Ed25519",
				false,
				["verify"],
			);
			assert(
				await crypto.subtle.verify(
					"Ed25519",
					verifying,
					b64urlToBytes(signature),
					requestMessage({
						origin: "https://clip.example",
						ts: Number(ts),
						nonce,
						method: "POST",
						path: "/api/register-key",
						hash,
					}),
				),
			);
			return new Response(null, { status: 204 });
		},
	);
	await registerKey({
		serverUrl: "https://clip.example",
		key,
		otc: " invitation ",
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(
		registerKey({
			serverUrl: "https://clip.example",
			key,
			otc: "invitation",
			signal: controller.signal,
		}),
		{ name: "AbortError" },
	);
});
