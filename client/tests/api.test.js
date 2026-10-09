import assert from "node:assert/strict";
import test from "node:test";

import {
	getContent,
	list,
	MAX_FILE_BYTES,
	registerKey,
	remove,
	upload,
} from "../src/lib/api.js";
import { generatePrivateKey } from "../src/lib/identity.js";

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
		if (original === undefined) delete globalThis.XMLHttpRequest;
		else globalThis.XMLHttpRequest = original;
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
		onProgress: (percent) => progress.push(percent),
	});
	assert.equal(result.id, "saved");
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
