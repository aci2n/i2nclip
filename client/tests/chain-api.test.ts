import assert from "node:assert/strict";
import test from "node:test";
import { createChainApi, HttpError } from "../src/lib/chain-api.ts";
import { b64urlToBytes, bytesToHex } from "../src/lib/protocol/bytes.ts";
import { MAX_BLOB_BYTES, sha256 } from "../src/lib/protocol/chain.ts";
import { bodyHash, requestMessage } from "../src/lib/protocol/crypto.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import { createDevice } from "./library-fixture.ts";

const binary = (n: number) => new Uint8Array(32).fill(n);
const response = (value: unknown) => new Response(encode(value));

test("chain API signs the exact query and uses fixed registration, pagination and receipt frames", async (t) => {
	const device = await createDevice("https://example.test");
	assert(device.identity.registration);
	const verifier = await crypto.subtle.importKey(
		"raw",
		device.key.publicKey,
		"Ed25519",
		false,
		["verify"],
	);
	const seen: string[] = [];
	const api = createChainApi(
		device.identity.serverUrl,
		device.key,
		new AbortController().signal,
		async function (this: typeof globalThis, input, init) {
			assert.equal(this, globalThis);
			const url = new URL(String(input));
			const options = init ?? {};
			seen.push(url.pathname);
			const fields = (new Headers(options.headers).get("authorization") ?? "")
				.slice(7)
				.split(".");
			const [publicKey, ts, nonce, hash, signature] = fields;
			assert.ok(publicKey && ts && nonce && hash && signature);
			const body = options.body
				? new Uint8Array(await new Response(options.body).arrayBuffer())
				: new Uint8Array();
			assert.equal(hash, await bodyHash(body));
			assert.equal(
				await crypto.subtle.verify(
					"Ed25519",
					verifier,
					b64urlToBytes(signature),
					requestMessage({
						origin: url.origin,
						ts: Number(ts),
						nonce,
						method: options.method ?? "GET",
						path: `${url.pathname}${url.search}`,
						hash,
					}),
				),
				true,
			);
			assert.equal(options.redirect, "error");
			assert.equal(options.credentials, "omit");
			if (url.pathname === "/api/register-key") {
				assert.deepEqual(decode(body), [
					"invite",
					device.identity.genesis,
					device.identity.registration,
				]);
				return new Response(null, { status: 204 });
			}
			if (options.method === "GET") {
				return response([binary(2), 2, [], null]);
			}
			assert.deepEqual(body, new Uint8Array([1, 2, 3]));
			return response([binary(1), 1, binary(2), 2]);
		},
	);
	t.after(api.dispose);
	await api.register(
		" invite ",
		device.identity.genesis,
		device.identity.registration,
		new AbortController().signal,
	);
	const page = await api.read(
		bytesToHex(binary(1)),
		bytesToHex(binary(2)),
		new AbortController().signal,
	);
	assert.equal(page.target.sequence, 2);
	assert.deepEqual(
		await api.append(new Uint8Array([1, 2, 3]), new AbortController().signal),
		{
			accepted: { sequence: 1, hash: bytesToHex(binary(1)) },
			head: { sequence: 2, hash: bytesToHex(binary(2)) },
		},
	);
	assert.deepEqual(seen, ["/api/register-key", "/api/blocks", "/api/blocks"]);
});

test("blob staging and downloads authenticate addresses while quota remains operational", async (t) => {
	const device = await createDevice("https://example.test");
	const blob = new Uint8Array(48).fill(7);
	const hash = await sha256(blob);
	let corrupt = false;
	const api = createChainApi(
		device.identity.serverUrl,
		device.key,
		new AbortController().signal,
		async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (path === "/api/quota") {
				return response([1000, 10, 48, 1, 64]);
			}
			if (init?.method === "POST") {
				const frame = decode(
					new Uint8Array(await new Response(init.body).arrayBuffer()),
				);
				assert.deepEqual(frame, [binary(3), blob]);
				return response([corrupt ? binary(0) : hash]);
			}
			return new Response(corrupt ? new Uint8Array(48) : blob);
		},
	);
	t.after(api.dispose);
	const signal = new AbortController().signal;
	assert.deepEqual(await api.putBlob(binary(3), blob, signal), hash);
	assert.deepEqual(
		await api.blob(bytesToHex(binary(3)), bytesToHex(hash), signal),
		blob,
	);
	assert.deepEqual(await api.quota(signal), {
		maximumBytes: 1000,
		maximumFiles: 10,
		usedBytes: 48,
		retainedFiles: 1,
		logBytes: 64,
	});
	corrupt = true;
	await assert.rejects(api.putBlob(binary(3), blob, signal), /different blob/);
	await assert.rejects(
		api.blob(bytesToHex(binary(3)), bytesToHex(hash), signal),
		/match its hash/,
	);
});

test("streaming bounds ignore false Content-Length and cancel an oversized body", async (t) => {
	const device = await createDevice("https://example.test");
	let cancelled = false;
	const api = createChainApi(
		device.identity.serverUrl,
		device.key,
		new AbortController().signal,
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(MAX_BLOB_BYTES));
						controller.enqueue(new Uint8Array(1));
					},
					cancel() {
						cancelled = true;
					},
				}),
				{ headers: { "Content-Length": "16" } },
			),
	);
	t.after(api.dispose);
	await assert.rejects(
		api.blob(
			bytesToHex(binary(1)),
			bytesToHex(binary(2)),
			new AbortController().signal,
		),
		/protocol limit/,
	);
	assert.equal(cancelled, true);
});

test("registration distinguishes unauthorized access and rejects malformed protocol responses", async (t) => {
	const device = await createDevice("https://example.test");
	let status = 401;
	const api = createChainApi(
		device.identity.serverUrl,
		device.key,
		new AbortController().signal,
		async () => new Response(null, { status }),
	);
	t.after(api.dispose);
	const signal = new AbortController().signal;
	assert.equal(await api.registered(signal), false);
	status = 204;
	assert.equal(await api.registered(signal), true);
	status = 503;
	await assert.rejects(
		api.registered(signal),
		(error) => error instanceof HttpError && error.status === 503,
	);
	const malformed = createChainApi(
		device.identity.serverUrl,
		device.key,
		signal,
		async () => response({ head: binary(1) }),
	);
	t.after(malformed.dispose);
	await assert.rejects(
		malformed.read(bytesToHex(binary(0)), null, signal),
		/frame/,
	);
	malformed.dispose();
	await assert.rejects(malformed.registered(signal), /abort/i);
});
