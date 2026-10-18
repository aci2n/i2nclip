import assert from "node:assert/strict";
import test from "node:test";
import { prepareFile } from "../src/lib/media/prepare.ts";
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
		const preparing = prepareFile({
			file,
			signal: new AbortController().signal,
			compressImages: true,
			maxFilePlaintextBytes: 200,
		});
		if (outputSize === 100) {
			const result = await preparing;
			assert.equal(result.name, "source.webp");
			assert.equal(result.size, 100);
		} else {
			await assert.rejects(preparing, /larger than 200 bytes/);
		}
		assert.equal(decoded(), 1);
	});
}

test("disabled and ineligible uploads reject before decoding or reading bytes", async (t) => {
	const decoded = imageEncoder(t, 100);
	for (const [type, enabled, limit] of [
		["image/png", false, 200],
		["application/octet-stream", true, 200],
		["video/mp4", true, 200],
		["image/png", true, 0],
	] as const) {
		const file = new File([new Uint8Array(1000)], "file", { type });
		file.arrayBuffer = async () => assert.fail("must not read");

		await assert.rejects(
			prepareFile({
				file,
				signal: new AbortController().signal,
				compressImages: enabled,
				maxFilePlaintextBytes: limit,
			}),
			limit === 0 ? /disabled/ : /larger than/,
		);
	}
	assert.equal(decoded(), 0);
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

test("videos and disabled images preserve their original file without decoding", async (t) => {
	const decoded = imageEncoder(t, 100);
	for (const [type, compressImages] of [
		["video/mp4", true],
		["image/png", false],
	] as const) {
		const file = new File(["original"], "source", { type });
		assert.equal(
			await prepareFile({
				file,
				compressImages,
				signal: new AbortController().signal,
			}),
			file,
		);
	}
	assert.equal(decoded(), 0);
});
