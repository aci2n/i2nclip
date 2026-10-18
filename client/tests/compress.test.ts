import assert from "node:assert/strict";
import test from "node:test";
import { compressImage } from "../src/lib/media/image.ts";
import {
	defaultUploadOptions,
	type ImageOptions,
} from "../src/lib/media/options.ts";
import { deferred } from "./helpers.ts";

function encoder(
	t: test.TestContext,
	encode: () => Promise<Blob>,
	options: ImageOptions = defaultUploadOptions().image,
	size = [640, 480],
) {
	let closed = 0;
	const scale = Math.min(
		1,
		(options.maxWidth ?? size[0]) / size[0],
		(options.maxHeight ?? size[1]) / size[1],
	);
	const width = Math.max(1, Math.floor(size[0] * scale));
	const height = Math.max(1, Math.floor(size[1] * scale));
	let filled = false;
	t.mock.method(globalThis, "createImageBitmap", async () => ({
		width: size[0],
		height: size[1],
		close() {
			closed++;
		},
	}));
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: class {
			constructor(w: number, h: number) {
				assert.equal(w, width);
				assert.equal(h, height);
			}
			getContext() {
				return {
					canvas: this,
					fillStyle: "",
					fillRect(x: number, y: number, w: number, h: number) {
						assert.equal(this.fillStyle, "#fff");
						assert.deepEqual([x, y, w, h], [0, 0, width, height]);
						filled = true;
					},
					drawImage(_bitmap: unknown, ...args: number[]) {
						assert.deepEqual(args, [0, 0, width, height]);
						assert.equal(filled, options.format === "jpeg");
					},
				};
			}
			convertToBlob(config: unknown) {
				assert.deepEqual(config, {
					type: `image/${options.format}`,
					quality: options.format === "png" ? undefined : options.quality / 100,
				});
				return encode();
			}
		},
	});
	return () => closed;
}

// Browser-only globals are scoped to each test and restored after it finishes.
function browser(t: test.TestContext) {
	for (const key of ["createImageBitmap", "OffscreenCanvas", "document"]) {
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
		const notices: string[] = [];
		assert.equal(
			await compressImage(
				file,
				new AbortController().signal,
				defaultUploadOptions().image,
				(message) => notices.push(message),
			),
			file,
		);
		assert.equal(notices.length, 1);
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

for (const format of ["webp", "jpeg", "png"] as const) {
	for (const [size, bounds] of [
		[[1920, 1080], { maxWidth: 800, maxHeight: 800 }],
		[[1080, 1920], { maxWidth: null, maxHeight: 600 }],
		[[1920, 1080], { maxWidth: 600, maxHeight: null }],
		[[40, 20], { maxWidth: 800, maxHeight: 800 }],
	] as const) {
		test(`${format} applies quality and bounds ${JSON.stringify(bounds)} to ${size}`, async (t) => {
			browser(t);
			const options = {
				...defaultUploadOptions().image,
				format,
				quality: 42,
				...bounds,
			};
			const closed = encoder(
				t,
				async () => new Blob(["x"], { type: `image/${format}` }),
				options,
				[...size],
			);
			const result = await compressImage(
				new File(["original"], "photo.bmp", { type: "image/bmp" }),
				new AbortController().signal,
				options,
			);
			assert.equal(result.type, `image/${format}`);
			assert.equal(result.name, `photo.${format === "jpeg" ? "jpg" : format}`);
			assert.equal(closed(), 1);
		});
	}
}

test("disabled conversion never decodes", async (t) => {
	browser(t);
	t.mock.method(globalThis, "createImageBitmap", () =>
		assert.fail("must not decode"),
	);
	const file = new File(["data"], "image.png", { type: "image/png" });
	assert.equal(
		await compressImage(file, new AbortController().signal, {
			...defaultUploadOptions().image,
			enabled: false,
		}),
		file,
	);
});

test("cancellation during decoding closes the late bitmap and never falls back", async (t) => {
	browser(t);
	const waiting = deferred<ImageBitmap>();
	t.mock.method(globalThis, "createImageBitmap", () => waiting.promise);
	const controller = new AbortController();
	const notices: string[] = [];
	const pending = compressImage(
		new File(["image"], "photo.png", { type: "image/png" }),
		controller.signal,
		defaultUploadOptions().image,
		(message) => notices.push(message),
	);
	controller.abort();
	let closed = false;
	waiting.resolve({
		close() {
			closed = true;
		},
	} as ImageBitmap);
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(closed, true);
	assert.deepEqual(notices, []);
});

test("HTML canvas fallback applies dimensions and requested encoding", async (t) => {
	browser(t);
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		value: undefined,
	});
	t.mock.method(globalThis, "createImageBitmap", async () => ({
		width: 640,
		height: 480,
		close() {},
	}));
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement(tag: string) {
				assert.equal(tag, "canvas");
				return {
					width: 0,
					height: 0,
					getContext() {
						return {
							canvas: this,
							drawImage(_bitmap: unknown, ...args: number[]) {
								assert.deepEqual(args, [0, 0, 320, 240]);
							},
						};
					},
					toBlob(
						callback: (blob: Blob) => void,
						type: string,
						quality: number,
					) {
						assert.equal(this.width, 320);
						assert.equal(this.height, 240);
						assert.equal(type, "image/webp");
						assert.equal(quality, 0.4);
						callback(new Blob(["x"], { type }));
					},
				};
			},
		},
	});
	const result = await compressImage(
		new File(["original"], "photo.png", { type: "image/png" }),
		new AbortController().signal,
		{ ...defaultUploadOptions().image, maxWidth: 320, quality: 40 },
	);
	assert.equal(result.name, "photo.webp");
});
