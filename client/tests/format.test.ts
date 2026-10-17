import assert from "node:assert/strict";
import test from "node:test";
import { fileSize } from "../src/lib/media/format.ts";

test("file sizes choose the highest binary unit", () => {
	for (const [bytes, expected] of [
		[0, "0 B"],
		[1023, "1023 B"],
		[1024, "1.0 KB"],
		[1024 ** 2, "1.0 MB"],
		[1024 ** 3 - 1, "1024.0 MB"],
		[1024 ** 3, "1.0 GB"],
		[10 * 1024 ** 3, "10.0 GB"],
		[1024 ** 4, "1.0 TB"],
		[1024 ** 5, "1.0 PB"],
		[1024 ** 6, "1.0 EB"],
	] as const) {
		assert.equal(fileSize(bytes), expected);
	}
	for (const invalid of [undefined, -1, Number.NaN, Infinity]) {
		assert.equal(fileSize(invalid), "");
	}
});
