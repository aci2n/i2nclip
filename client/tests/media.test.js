import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FILE_BYTES } from "../src/lib/api.js";
import { prepareMedia, readMedia } from "../src/lib/media/upload.js";

test("oversized local files are rejected before reading or fetching", async () => {
	const source = {
		blob: {
			size: MAX_FILE_BYTES + 1,
			arrayBuffer: () => {
				throw new Error("must not read");
			},
		},
	};
	await assert.rejects(prepareMedia(source, {}), /larger than 32 MB/);
});

test("remote media is capped without trusting Content-Length and cancels its reader", async () => {
	let cancelled = false;
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_FILE_BYTES));
				controller.enqueue(new Uint8Array(1));
			},
			cancel() {
				cancelled = true;
			},
		}),
		{ headers: { "content-length": "1" } },
	);
	await assert.rejects(readMedia(response), /larger than 32 MB/);
	assert.equal(cancelled, true);
});

test("remote reads are cancelled when the owning screen closes", async () => {
	const controller = new AbortController();
	let cancelled = false;
	const response = new Response(
		new ReadableStream({
			cancel() {
				cancelled = true;
			},
		}),
	);
	const reading = readMedia(response, controller.signal);
	controller.abort();
	await assert.rejects(reading, { name: "AbortError" });
	assert.equal(cancelled, true);
});
