import assert from "node:assert/strict";
import test from "node:test";
import { PREPARATION_BYTES } from "../src/lib/media/prepare.ts";
import { thumbnail } from "../src/lib/media/thumbnail.ts";
import { deferred } from "./helpers.ts";

function browserGlobal(t: test.TestContext, name: string, value: unknown) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { configurable: true, value });
	t.after(() => {
		if (previous) {
			Object.defineProperty(globalThis, name, previous);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	});
}

function videoFixture(
	t: test.TestContext,
	encode = async () => new Blob(["webp"]),
) {
	const video = Object.assign(new EventTarget(), {
		videoWidth: 1920,
		videoHeight: 1080,
		src: "",
		removeAttribute(name: string) {
			assert.equal(name, "src");
			video.src = "";
		},
		load() {},
	});
	let revoked = 0;
	let drawn = 0;
	let detached = 0;
	browserGlobal(t, "document", {
		createElement(tag: string) {
			assert.equal(tag, "video");
			return video;
		},
	});
	browserGlobal(
		t,
		"OffscreenCanvas",
		class {
			width: number;
			height: number;
			constructor(width: number, height: number) {
				this.width = width;
				this.height = height;
			}
			getContext() {
				return {
					canvas: this,
					drawImage(source: unknown, ...args: number[]) {
						assert.equal(source, video);
						assert.deepEqual(args, [0, 0, 320, 180]);
						drawn++;
					},
				};
			}
			convertToBlob() {
				return encode();
			}
		},
	);
	const file = new File([], "huge.mp4", { type: "video/mp4" });
	Object.defineProperty(file, "size", { value: 1024 ** 3 + 1 });
	t.mock.method(file, "arrayBuffer", async () =>
		assert.fail("whole-file video read"),
	);
	t.mock.method(URL, "createObjectURL", (blob: Blob | MediaSource) => {
		assert.equal(blob, file);
		return "blob:video";
	});
	t.mock.method(URL, "revokeObjectURL", (url: string) => {
		assert.equal(url, "blob:video");
		revoked++;
	});
	t.mock.method(video, "load", () => {
		detached++;
	});
	return {
		video,
		file,
		resources: () => ({ revoked, drawn, detached }),
	};
}

test("large videos use the original File and a bounded canvas without a whole-file read", async (t) => {
	const f = videoFixture(t);
	const pending = thumbnail(f.file);
	f.video.dispatchEvent(new Event("loadeddata"));
	f.video.dispatchEvent(new Event("loadeddata"));
	const preview = await pending;
	assert(preview);
	assert.deepEqual(preview.image, { width: 1920, height: 1080 });
	assert.equal(new TextDecoder().decode(preview.thumb), "webp");
	assert.deepEqual(f.resources(), { revoked: 1, drawn: 1, detached: 1 });
});

for (const outcome of ["abort", "timeout", "error"] as const) {
	test(`${outcome} releases video resources and ignores later decode events`, async (t) => {
		const f = videoFixture(t);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const controller = new AbortController();
		const pending = thumbnail(f.file, controller.signal);
		if (outcome === "abort") {
			controller.abort();
		} else if (outcome === "timeout") {
			t.mock.timers.tick(8000);
		} else {
			f.video.dispatchEvent(new Event("error"));
		}
		assert.equal(await pending, null);
		f.video.dispatchEvent(new Event("loadeddata"));
		f.video.dispatchEvent(new Event("error"));
		t.mock.timers.tick(16000);
		assert.deepEqual(f.resources(), { revoked: 1, drawn: 0, detached: 1 });
	});
}

test("cancelling during video encoding releases resources before late output arrives", async (t) => {
	const encoded = deferred<Blob>();
	const f = videoFixture(t, () => encoded.promise);
	const controller = new AbortController();
	const pending = thumbnail(f.file, controller.signal);
	f.video.dispatchEvent(new Event("loadeddata"));
	controller.abort();
	assert.equal(await pending, null);
	encoded.resolve(new Blob(["late"]));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(f.resources(), { revoked: 1, drawn: 1, detached: 1 });
});

for (const type of ["image/png", "audio/mp3"]) {
	test(`large ${type} skips preparation without reading or decoding`, async (t) => {
		const file = new File([], "huge", { type });
		Object.defineProperty(file, "size", { value: PREPARATION_BYTES + 1 });
		t.mock.method(file, "arrayBuffer", async () =>
			assert.fail("whole-file read"),
		);
		browserGlobal(t, "createImageBitmap", () =>
			assert.fail("large image decode"),
		);
		assert.equal(await thumbnail(file), null);
	});
}

test("small audio reads bytes only for artwork extraction", async (t) => {
	const file = new File(["no embedded artwork"], "audio.mp3", {
		type: "audio/mp3",
	});
	let reads = 0;
	t.mock.method(file, "arrayBuffer", async () => {
		reads++;
		return new TextEncoder().encode("no embedded artwork").buffer;
	});
	assert.equal(await thumbnail(file), null);
	assert.equal(reads, 1);
});

test("video encoding failure keeps thumbnail preparation best effort", async (t) => {
	const f = videoFixture(t, async () => {
		throw new Error("encoder failed");
	});
	const pending = thumbnail(f.file);
	f.video.dispatchEvent(new Event("loadeddata"));
	assert.equal(await pending, null);
	assert.deepEqual(f.resources(), { revoked: 1, drawn: 1, detached: 1 });
});

test("small images decode the Blob directly and close their bitmap", async (t) => {
	const file = new File(["image"], "image.png", { type: "image/png" });
	t.mock.method(file, "arrayBuffer", async () =>
		assert.fail("unneeded whole-file image read"),
	);
	let closed = false;
	const bitmap = {
		width: 640,
		height: 480,
		close() {
			closed = true;
		},
	};
	browserGlobal(t, "createImageBitmap", async (blob: Blob) => {
		assert.equal(blob, file);
		return bitmap;
	});
	browserGlobal(
		t,
		"OffscreenCanvas",
		class {
			width = 0;
			height = 0;
			getContext() {
				return {
					canvas: this,
					drawImage(source: unknown, ...args: number[]) {
						assert.equal(source, bitmap);
						assert.deepEqual(args, [0, 0, 320, 240]);
					},
				};
			}
			async convertToBlob() {
				return new Blob(["webp"]);
			}
		},
	);
	assert.deepEqual((await thumbnail(file))?.image, { width: 640, height: 480 });
	assert.equal(closed, true);
});
