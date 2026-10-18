import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BufferTarget, Conversion, type ConversionOptions } from "mediabunny";
import { convertMedia } from "../src/lib/media/convert.ts";
import { defaultUploadOptions } from "../src/lib/media/options.ts";
import { sendUpload } from "../src/lib/media/upload.ts";
import { testKey } from "./helpers.ts";
import { documentResponse } from "./msgpack-response.ts";

function imageEncoder(t: test.TestContext, outputSize: number | null) {
	for (const key of ["createImageBitmap", "OffscreenCanvas"]) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, key);
		t.after(() => {
			if (previous) {
				Object.defineProperty(globalThis, key, previous);
			} else {
				Reflect.deleteProperty(globalThis, key);
			}
		});
	}
	let decoded = 0;
	Object.defineProperty(globalThis, "createImageBitmap", {
		configurable: true,
		writable: true,
		value: async () => {
			decoded++;
			return { width: 100, height: 100, close() {} };
		},
	});
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		value: class {
			getContext() {
				return { canvas: this, drawImage() {} };
			}
			async convertToBlob() {
				if (outputSize === null) {
					throw new Error("encoder failed");
				}
				return new Blob([new Uint8Array(outputSize)], { type: "image/webp" });
			}
		},
	});
	return () => decoded;
}

for (const outputSize of [100, 500, null]) {
	test(`oversized image gets an encoding attempt and its selected size is enforced (${outputSize})`, async (t) => {
		const decoded = imageEncoder(t, outputSize);
		const file = new File([new Uint8Array(1000)], "source.png", {
			type: "image/png",
		});
		file.arrayBuffer = async () =>
			assert.fail("must not read the oversized original");
		const converting = convertMedia({
			file,
			signal: new AbortController().signal,
			options: defaultUploadOptions(),
			maxFilePlaintextBytes: 200,
		});
		if (outputSize === 100) {
			const result = await converting;
			assert.equal(result.name, "source.webp");
			assert.equal(result.size, 100);
		} else {
			await assert.rejects(converting, /larger than 200 bytes/);
		}
		assert.equal(decoded(), 1);
	});
}

test("disabled and ineligible uploads reject before decoding or reading bytes", async (t) => {
	const decoded = imageEncoder(t, 100);
	for (const [type, enabled, limit] of [
		["image/png", false, 200],
		["application/octet-stream", true, 200],
		["image/png", true, 0],
	] as const) {
		const file = new File([new Uint8Array(1000)], "file", { type });
		file.arrayBuffer = async () => assert.fail("must not read");
		const options = defaultUploadOptions();
		options.image.enabled = enabled;
		await assert.rejects(
			convertMedia({
				file,
				signal: new AbortController().signal,
				options,
				maxFilePlaintextBytes: limit,
			}),
			limit === 0 ? /disabled/ : /larger than/,
		);
	}
	assert.equal(decoded(), 0);
});

test("oversized video reaches the encoder and only smaller permitted output is returned", async (t) => {
	const bytes = await readFile(
		new URL("../e2e/fixtures/clip.webm", import.meta.url),
	);
	let size = 100;
	let attempts = 0;
	t.mock.method(Conversion, "init", async ({ output }: ConversionOptions) => {
		attempts++;
		let state = "idle";
		return {
			isValid: true,
			discardedTracks: [],
			get state() {
				return state;
			},
			onProgress: undefined,
			async execute() {
				assert(output.target instanceof BufferTarget);
				output.target.buffer = new ArrayBuffer(size);
				output.state = "finalized";
				state = "done";
			},
			async cancel() {
				await output.cancel();
			},
		} as unknown as Conversion;
	});
	const options = defaultUploadOptions();
	options.video.enabled = true;
	options.video.format = "webm";
	options.video.codec = "vp8";
	const source = new File([bytes], "source.webm", { type: "video/webm" });
	assert.equal(
		(
			await convertMedia({
				file: source,
				options,
				signal: new AbortController().signal,
				maxFilePlaintextBytes: 200,
			})
		).size,
		100,
	);
	size = 500;
	await assert.rejects(
		convertMedia({
			file: source,
			options,
			signal: new AbortController().signal,
			maxFilePlaintextBytes: 200,
		}),
		/larger than 200 bytes/,
	);
	assert.equal(attempts, 2);
});

test("upload preparation publishes the accepted converted name", async (t) => {
	imageEncoder(t, 100);
	t.mock.method(globalThis, "fetch", async () =>
		documentResponse({ id: "saved", created_at: 1 }, { status: 201 }),
	);
	const names: string[] = [];
	const result = await sendUpload({
		file: new File([new Uint8Array(1000)], "source.png", { type: "image/png" }),
		maxFilePlaintextBytes: 200,
		credentials: { serverUrl: "https://clip.example", key: testKey() },
		signal: new AbortController().signal,
		onPrepared: (name) => names.push(name),
	});
	assert.deepEqual(names, ["source.webp"]);
	assert.equal(result.metadata.name, "source.webp");
});
