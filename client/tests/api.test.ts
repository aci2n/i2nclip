import assert from "node:assert/strict";
import test from "node:test";
import {
	getMedia,
	getQuota,
	isKeyRegistered,
	list,
	readContentRange,
	registerKey,
	updateMetadata,
	upload,
} from "../src/lib/api.ts";
import { hexToBytes } from "../src/lib/protocol/bytes.ts";
import {
	CHUNK_BYTES,
	chunkLength,
	contentShape,
	createContent,
	decryptChunk,
	encryptChunk,
	sealDescriptor,
} from "../src/lib/protocol/content.ts";
import {
	authorizationHeader,
	bodyHash,
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
import { decode } from "../src/lib/protocol/msgpack.ts";
import { bytes as binary, document } from "../src/lib/protocol/value.ts";
import { assertPresent } from "./assert.ts";
import { requestBody, requestDocument, testKey } from "./helpers.ts";
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

test("metadata list and update sign their routes and preserve decrypted fields", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const key = await loadKey(privateKey);
	const id = "a".repeat(64);
	const { descriptor, content } = await sealDescriptor(
		key,
		id,
		3,
		new Uint8Array(32),
	);
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
				bytes: 19,
				descriptor,
				expected_chunk_count: 1,
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
		bytes: 19,
		content,
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

test("direct metadata reads use signed empty GETs, decrypt summaries, and reject mismatched IDs", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const key = await loadKey(privateKey);
	const id = "a".repeat(64);
	const { descriptor } = await sealDescriptor(key, id, 3, new Uint8Array(32));
	const controller = new AbortController();
	let responseId = id;
	let damaged = false;
	let calls = 0;
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, options: RequestInit = {}) => {
			calls++;
			assert.equal(String(url), `https://clip.example/api/media/${id}/meta`);
			assert.equal(options.method, "GET");
			assert.equal(options.body, undefined);
			assert.equal(options.signal, controller.signal);
			assert(new Headers(options.headers).get("authorization"));
			const meta = await encrypt(
				key,
				metaAad(responseId),
				encodeMetaPlain(
					{ name: "Portrait.png", content_type: "image/png" },
					new Uint8Array([1, 2]),
				),
			);
			if (damaged) {
				meta[meta.length - 1] ^= 1;
			}
			return documentResponse({
				id: responseId,
				created_at: 1,
				bytes: 19,
				descriptor,
				expected_chunk_count: 1,
				meta,
			});
		},
	);
	const request = {
		id,
		key,
		serverUrl: "https://clip.example",
		signal: controller.signal,
	};
	const media = await getMedia(request);
	assert.equal(media.metadata?.name, "Portrait.png");
	assert.deepEqual(media.thumb, new Uint8Array([1, 2]));
	damaged = true;
	assert.equal((await getMedia(request)).metadata, null);
	damaged = false;
	responseId = "b".repeat(64);
	await assert.rejects(getMedia(request), /Invalid media response/);
	const before = calls;
	await assert.rejects(
		getMedia({ ...request, id: "bad" }),
		/Invalid media link/,
	);
	assert.equal(calls, before);
});

function uploadServer(t: test.TestContext, key = testKey()) {
	let item: Record<string, unknown> | undefined;
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	const calls: string[] = [];
	const signatures = new Set<string>();
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, options: RequestInit = {}) => {
			const path = new URL(String(url)).pathname;
			const method = options.method || "GET";
			calls.push(`${method} ${path}`);
			const auth = assertPresent(
				new Headers(options.headers).get("authorization"),
			);
			assert(!signatures.has(auth));
			signatures.add(auth);
			const [, ts, nonce] = auth.slice(7).split(".");
			assert.equal(
				auth,
				await authorizationHeader({
					key,
					origin: "https://clip.example",
					ts: Number(ts),
					nonce,
					method,
					path,
					body: options.body ? requestBody(options) : new Uint8Array(),
				}),
			);
			if (method === "POST") {
				item = requestDocument(options);
				assert.equal("content" in item, false);
				const shape = contentShape(Number(item.plaintext_bytes));
				return documentResponse({
					id: item.id,
					expected_chunk_count: shape.chunks,
					current_chunk_count: 0,
				});
			}
			if (method === "PUT") {
				assert.equal(
					new Headers(options.headers).get("content-type"),
					"application/octet-stream",
				);
				chunks.push(requestBody(options).slice());
				return new Response(null, { status: 204 });
			}
			assert(item);
			return documentResponse({
				...item,
				bytes: contentShape(Number(item.plaintext_bytes)).encryptedBytes,
				expected_chunk_count: chunks.length,
				created_at: 123,
			});
		},
	);
	return {
		key,
		chunks,
		calls,
		get item() {
			return assertPresent(item);
		},
	};
}

for (const size of [0, CHUNK_BYTES + 19]) {
	test(`upload slices ${size} bytes, independently encrypts chunks and completes progress after publication`, async (t) => {
		const server = uploadServer(t);
		const plain = new Uint8Array(size).fill(7);
		const file = new Blob([plain]);
		t.mock.method(file, "arrayBuffer", async () =>
			assert.fail("whole-file read"),
		);
		const progress: number[] = [];
		const saved = await upload({
			serverUrl: "https://clip.example",
			key: server.key,
			file,
			name: "folder/sample.bin",
			tags: ["One"],
			onProgress: (p) => progress.push(p),
		});
		assert.match(saved.id, /^[a-f0-9]{64}$/);
		assert.equal(saved.metadata?.name, "sample.bin");
		assert.equal(saved.content?.size, size);
		assert.equal(saved.bytes, size + server.chunks.length * 16);
		const content = assertPresent(saved.content);
		for (let i = 0; i < content.chunks; i++) {
			assert.equal(server.chunks[i].length, chunkLength(content, i) + 16);
			assert.deepEqual(
				await decryptChunk(content, i, server.chunks[i]),
				plain.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES),
			);
		}
		assert.equal(progress.at(-1), 100);
		assert(progress.slice(0, -1).every((p) => p < 100));
		assert.equal(server.calls.length, content.chunks + 2);
	});
}

test("failed upload attempts delete their reservation and retry with a fresh ID and key", async (t) => {
	const key = testKey();
	const ids: string[] = [];
	const descriptors: Uint8Array[] = [];
	const deleted: string[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, options: RequestInit = {}) => {
			if (options.method === "POST") {
				const value = requestDocument(options);
				ids.push(String(value.id));
				descriptors.push(binary(value.descriptor));
				throw new Error("lost creation response");
			}
			assert.equal(options.method, "DELETE");
			deleted.push(new URL(String(url)).pathname.split("/").at(-1) || "");
			return new Response(null, { status: 204 });
		},
	);
	for (let i = 0; i < 2; i++) {
		await assert.rejects(
			upload({
				serverUrl: "https://clip.example",
				key,
				file: new Blob(["x"]),
				name: "x",
			}),
			/lost creation/,
		);
	}
	assert.deepEqual(deleted, ids);
	assert.notEqual(ids[0], ids[1]);
	assert.notDeepEqual(descriptors[0], descriptors[1]);
});

test("range reads cross independently authenticated chunks with bounded allocation", async (t) => {
	const key = testKey();
	const { content } = await createContent(key, CHUNK_BYTES + 10);
	const plain = new Uint8Array(content.size).map((_, i) => i % 251);
	const chunks = await Promise.all(
		[0, 1].map((i) =>
			encryptChunk(
				content,
				i,
				plain.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES),
			),
		),
	);
	const calls: number[] = [];
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
		const index = Number(new URL(String(url)).pathname.split("/").at(-1));
		calls.push(index);
		return new Response(chunks[index]);
	});
	const request = {
		serverUrl: "https://clip.example",
		key,
		content,
		start: CHUNK_BYTES - 3,
		end: CHUNK_BYTES + 7,
	};
	assert.deepEqual(
		await readContentRange(request),
		plain.slice(request.start, request.end),
	);
	assert.deepEqual(calls, [0, 1]);
	chunks[1][0] ^= 1;
	await assert.rejects(readContentRange(request));
	await assert.rejects(
		readContentRange({ ...request, start: 0, end: content.size }),
		/Invalid content range/,
	);
});

for (const failure of [
	"oversized",
	"truncated",
	"wrong length",
	"wrong status",
	"cancelled",
] as const) {
	test(`range reads reject ${failure} ciphertext and release the response reader`, async (t) => {
		const key = testKey();
		const { content } = await createContent(key, 3);
		const controller = new AbortController();
		let cancelled = false;
		t.mock.method(
			globalThis,
			"fetch",
			async () =>
				new Response(
					new ReadableStream({
						start(stream) {
							if (failure === "cancelled") {
								stream.enqueue(new Uint8Array(1));
								setImmediate(() => controller.abort());
							} else if (failure === "oversized") {
								stream.enqueue(new Uint8Array(20));
							} else if (failure === "truncated") {
								stream.enqueue(new Uint8Array(1));
								stream.close();
							}
						},
						cancel() {
							cancelled = true;
						},
					}),
					{
						status: failure === "wrong status" ? 206 : 200,
						headers:
							failure === "wrong length" ? { "content-length": "1" } : {},
					},
				),
		);
		await assert.rejects(
			readContentRange({
				serverUrl: "https://clip.example",
				key,
				content,
				start: 0,
				end: 3,
				signal: controller.signal,
			}),
			failure === "cancelled"
				? { name: "AbortError" }
				: failure === "truncated"
					? /shorter/
					: failure === "oversized"
						? /exceeds/
						: /Invalid content chunk/,
		);
		if (failure !== "truncated") {
			assert.equal(cancelled, true);
		}
	});
}
