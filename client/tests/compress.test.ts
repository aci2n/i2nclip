import assert from "node:assert/strict";
import test from "node:test";
import { compressImage } from "../src/lib/media/compress.ts";
import { deferred } from "./helpers.ts";

function encoder(t: test.TestContext, encode: () => Promise<Blob>) {
	let closed = 0;
	t.mock.method(globalThis, "createImageBitmap", async () => ({
		width: 640,
		height: 480,
		close() {
			closed++;
		},
	}));
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: class {
			constructor(width: unknown, height: unknown) {
				assert.equal(width, 640);
				assert.equal(height, 480);
			}
			getContext() {
				return { drawImage() {} };
			}
			convertToBlob(options: unknown) {
				assert.deepEqual(options, { type: "image/webp", quality: 0.85 });
				return encode();
			}
		},
	});
	return () => closed;
}

// Browser-only globals are scoped to each test and restored after it finishes.
function browser(t: test.TestContext) {
	for (const key of ["createImageBitmap", "OffscreenCanvas"]) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value: () => {},
		});
		t.after(() => {
			if (previous) {
				Object.defineProperty(globalThis, key, previous);
			} else {
				Reflect.deleteProperty(globalThis, key);
			}
		});
	}
}

for (const type of ["image/png", "image/bmp", "image/x-ms-bmp"]) {
	test(`conversion uses smaller WebP for ${type} and closes its bitmap`, async (t) => {
		browser(t);
		const closed = encoder(
			t,
			async () => new Blob(["small"], { type: "image/webp" }),
		);
		const file = new File(
			["original image"],
			type === "image/png" ? "photo.PNG" : "photo.bmp",
			{ type },
		);
		const result = await compressImage(file, new AbortController().signal);
		assert.equal(result.name, "photo.webp");
		assert.equal(result.type, "image/webp");
		assert.equal(await result.text(), "small");
		assert.equal(closed(), 1);
	});
}

for (const [name, encode] of [
	[
		"larger output",
		async () => new Blob(["too much data"], { type: "image/webp" }),
	],
	["unsupported encoding", async () => new Blob(["x"], { type: "image/png" })],
	[
		"encoding failure",
		async () => {
			throw new Error("encoder failed");
		},
	],
] as const) {
	test(`conversion keeps original on ${name}`, async (t) => {
		browser(t);
		const closed = encoder(t, encode);
		const file = new File(["image"], "photo.jpg", { type: "image/jpeg" });
		assert.equal(await compressImage(file, new AbortController().signal), file);
		assert.equal(closed(), 1);
	});
}

test("cancellation during encoding rejects and closes the bitmap", async (t) => {
	browser(t);
	const waiting = deferred<Blob>();
	const entered = deferred();
	const closed = encoder(t, () => {
		entered.resolve();
		return waiting.promise;
	});
	const controller = new AbortController();
	const converting = compressImage(
		new File(["image"], "image.png", { type: "image/png" }),
		controller.signal,
	);
	await entered.promise;
	controller.abort();
	waiting.resolve(new Blob(["x"], { type: "image/webp" }));
	await assert.rejects(converting, { name: "AbortError" });
	assert.equal(closed(), 1);
});

test("other formats bypass decoding", async (t) => {
	browser(t);
	t.mock.method(globalThis, "createImageBitmap", () =>
		assert.fail("must not decode"),
	);
	for (const type of [
		"image/gif",
		"image/svg+xml",
		"image/webp",
		"text/plain",
	]) {
		const file = new File(["data"], "file", { type });
		assert.equal(await compressImage(file, new AbortController().signal), file);
	}
});
