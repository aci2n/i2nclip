import assert from "node:assert/strict";
import test from "node:test";

import {
	getContent,
	getMetadata,
	isKeyRegistered,
	list,
	MAX_FILE_BYTES,
	registerKey,
	remove,
	updateMetadata,
	upload,
} from "../src/lib/api.js";
import { bytesToB64, hexToBytes } from "../src/lib/protocol/bytes.js";
import {
	authorizationHeader,
	bodyHash,
	contentAad,
	decrypt,
	encrypt,
	loadKey,
	metaAad,
} from "../src/lib/protocol/crypto.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import {
	decodeMetaPlain,
	encodeMetaPlain,
} from "../src/lib/protocol/meta-plain.js";

test("registration checks use a signed empty ping, distinguish unauthorized keys and propagate server failures", async (t) => {
	const key = await generatePrivateKey();
	let status = 204;
	t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(String(url), "https://clip.example/api/ping");
		assert.equal(options.method, "GET");
		assert(options.headers.authorization);
		assert.equal(options.body, undefined);
		return status === 503
			? new Response(JSON.stringify({ error: "unavailable" }), { status })
			: new Response(null, { status });
	});
	const credentials = {
		serverUrl: "https://clip.example",
		privateKey: key.privateKey,
	};
	assert.equal(await isKeyRegistered(credentials), true);
	status = 401;
	assert.equal(await isKeyRegistered(credentials), false);
	status = 503;
	await assert.rejects(
		isKeyRegistered(credentials),
		(error) => error.status === 503,
	);
});

for (const [body, contentType, message] of [
	['{"error":"permission denied"}', "application/json", "permission denied"],
	["upstream unavailable", "text/plain", "upstream unavailable"],
	["", "text/plain", "Service Unavailable"],
]) {
	test(`API errors are consistent across endpoints: ${message}`, async (t) => {
		const { privateKey, publicKey } = await generatePrivateKey();
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
			privateKey,
			id: "test",
		};
		for (const request of [
			() => registerKey({ ...settings, publicKey, otc: "test" }),
			() => list(settings),
			() => getContent(settings),
			() => getMetadata(settings),
			() => remove(settings),
		]) {
			await assert.rejects(request, (error) => error.message === message);
		}
	});
}

test("upload progress uses the same response handling as fetch", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const requests = [];
	const original = globalThis.XMLHttpRequest;
	t.after(() => {
		if (original === undefined) {
			delete globalThis.XMLHttpRequest;
		} else {
			globalThis.XMLHttpRequest = original;
		}
	});
	globalThis.XMLHttpRequest = class {
		upload = {};
		status = 201;
		statusText = "Created";
		responseText = '{"id":"saved"}';
		open(method, url) {
			requests.push({ method, url: String(url) });
		}
		setRequestHeader() {}
		send(body) {
			this.upload.onprogress({
				lengthComputable: true,
				loaded: body.length,
				total: body.length,
			});
			this.onload();
		}
	};
	const progress = [];
	const result = await upload({
		serverUrl: "https://clip.example.com",
		privateKey,
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
	assert.deepEqual(result.metadata.tags, ["Vacation", "dog", "Cat"]);
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
			privateKey,
			id: "test",
		}),
		/larger than 32 MB/,
	);
	assert.equal(cancelled, true);
});

test("reencrypting an upload uses fresh sealed content after a lost response", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const bodies = [];
	const contentOf = (body) => {
		const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
		const offset = 4 + view.getUint32(0);
		return body.subarray(offset + 4, offset + 4 + view.getUint32(offset));
	};

	t.mock.method(globalThis, "fetch", async (_url, options) => {
		bodies.push(options.body);
		if (bodies.length === 1) {
			throw new Error("lost response");
		}
		return new Response(
			JSON.stringify({ id: await bodyHash(contentOf(options.body)) }),
			{ status: 201 },
		);
	});
	const options = {
		serverUrl: "https://clip.example",
		privateKey,
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
	const options = { serverUrl: "https://clip.example", privateKey };
	await assert.rejects(
		getContent({ ...options, id: "0".repeat(64) }),
		/Content hash mismatch/,
	);
	assert.deepEqual(
		await getContent({ ...options, id: await bodyHash(content) }),
		plain,
	);
});

test("metadata GET and PUT sign the meta route and preserve decrypted fields", async (t) => {
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
	const methods = [];
	t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(String(url), `https://clip.example/api/media/${id}/meta`);
		assert.equal(options.signal, controller.signal);
		const [, ts, nonce] = options.headers.authorization.slice(7).split(".");
		assert.equal(
			options.headers.authorization,
			await authorizationHeader({
				key,
				origin: "https://clip.example",
				ts: Number(ts),
				nonce,
				method: options.method,
				path: `/api/media/${id}/meta`,
				body: options.body ?? new Uint8Array(),
			}),
		);
		methods.push(options.method);
		if (options.method === "PUT") {
			const body = options.body;
			assert.deepEqual(body.subarray(0, 32), hexToBytes(await bodyHash(meta)));
			const length = new DataView(
				body.buffer,
				body.byteOffset + 32,
				4,
			).getUint32(0);
			const sealed = body.subarray(36, 36 + length);
			assert.deepEqual(
				decodeMetaPlain(await decrypt(key, metaAad(id), sealed)),
				{ metadata: renamed, thumb },
			);
			assert(!new TextDecoder().decode(body).includes(renamed.name));
		}
		return Response.json({
			id,
			created_at: 123,
			bytes: 32,
			tokens: ["token"],
			meta: bytesToB64(meta),
		});
	});
	const credentials = {
		serverUrl: "https://clip.example",
		privateKey,
		id,
		signal: controller.signal,
	};
	const item = await getMetadata(credentials);
	assert.deepEqual(item, {
		id,
		createdAt: 123,
		bytes: 32,
		metadata,
		thumb,
		metaHash: await bodyHash(meta),
		tokens: ["token"],
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
	await assert.rejects(getMetadata(credentials), { name: "AbortError" });
	assert.deepEqual(methods, ["GET", "PUT"]);
});

test("undecryptable metadata is returned without an editable payload", async (t) => {
	const { privateKey } = await generatePrivateKey();
	const meta = new Uint8Array(29);
	meta[0] = 1;
	t.mock.method(globalThis, "fetch", async () =>
		Response.json({
			id: "a".repeat(64),
			created_at: 1,
			bytes: 1,
			tokens: [],
			meta: bytesToB64(meta),
		}),
	);
	const item = await getMetadata({
		serverUrl: "https://clip.example",
		privateKey,
		id: "a".repeat(64),
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
		return Response.json({ id: "saved" }, { status: 201 });
	});
	await upload({
		serverUrl: "https://clip.example",
		privateKey,
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
		Response.json({ error: "not found" }, { status: 404 }),
	);
	await assert.rejects(
		getMetadata({
			serverUrl: "https://clip.example",
			privateKey,
			id: "a".repeat(64),
		}),
		(error) => error.status === 404 && error.message === "not found",
	);
});
