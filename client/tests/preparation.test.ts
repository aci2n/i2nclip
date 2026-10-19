import assert from "node:assert/strict";
import test from "node:test";
import { PREPARATION_BYTES, prepareFile } from "../src/lib/media/prepare.ts";

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

for (const outputSize of [100, 1500, null]) {
	test(`small image preparation selects the smaller valid WebP or preserves the original (${outputSize})`, async (t) => {
		const decoded = imageEncoder(t, outputSize);
		const file = new File([new Uint8Array(1000)], "source.png", {
			type: "image/png",
		});
		const result = await prepareFile({
			file,
			signal: new AbortController().signal,
			compressImages: true,
		});
		assert.equal(
			result.name,
			outputSize === 100 ? "source.webp" : "source.png",
		);
		assert.equal(result.size, outputSize === 100 ? 100 : 1000);
		assert.equal(decoded(), 1);
	});
}
test("large originals bypass optional decoding and explain skipped preparation", async (t) => {
	const decoded = imageEncoder(t, 100);
	const file = new File([], "huge.png", { type: "image/png" });
	Object.defineProperty(file, "size", { value: PREPARATION_BYTES + 1 });
	file.arrayBuffer = async () => assert.fail("whole-file read");
	const notices: string[] = [];
	assert.equal(
		await prepareFile({
			file,
			signal: new AbortController().signal,
			compressImages: true,
			onNotice: (message) => notices.push(message),
		}),
		file,
	);
	assert.equal(decoded(), 0);
	assert.match(notices[0], /Uploading original/);
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

test("large videos retain the original without a skipped-thumbnail notice", async () => {
	const file = new File([], "huge.mp4", { type: "video/mp4" });
	Object.defineProperty(file, "size", { value: PREPARATION_BYTES + 1 });
	const notices: string[] = [];
	assert.equal(
		await prepareFile({
			file,
			signal: new AbortController().signal,
			compressImages: true,
			onNotice: (message) => notices.push(message),
		}),
		file,
	);
	assert.deepEqual(notices, []);
});
