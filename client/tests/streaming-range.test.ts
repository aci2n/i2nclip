import assert from "node:assert/strict";
import test from "node:test";
import { byteRange } from "../src/lib/streaming/range.ts";

test("plaintext ranges support boundaries, suffixes and open ends", () => {
	assert.deepEqual(byteRange(null, 100), {
		start: 0,
		end: 100,
		partial: false,
	});
	assert.deepEqual(byteRange("bytes=10-19", 100), {
		start: 10,
		end: 20,
		partial: true,
	});
	assert.deepEqual(byteRange("bytes=90-999", 100), {
		start: 90,
		end: 100,
		partial: true,
	});
	assert.deepEqual(byteRange("bytes=90-", 100), {
		start: 90,
		end: 100,
		partial: true,
	});
	assert.deepEqual(byteRange("bytes=-10", 100), {
		start: 90,
		end: 100,
		partial: true,
	});
	assert.deepEqual(byteRange("bytes=-1000", 100), {
		start: 0,
		end: 100,
		partial: true,
	});
	assert.deepEqual(byteRange(null, 0), { start: 0, end: 0, partial: false });
	assert.deepEqual(byteRange("bytes=4294967296-4294967300", 2 ** 34), {
		start: 4294967296,
		end: 4294967301,
		partial: true,
	});
});

test("unsatisfiable ranges fail while unsupported ranges are ignored", () => {
	for (const header of ["bytes=100-", "bytes=20-10", "bytes=-0"]) {
		assert.equal(byteRange(header, 100), null);
	}
	assert.equal(byteRange("bytes=0-", 0), null);
	for (const header of [
		"bytes=0-1,4-5",
		"items=0-1",
		"bytes=-",
		"bytes=9007199254740992-",
		"garbage",
	]) {
		assert.deepEqual(byteRange(header, 100), {
			start: 0,
			end: 100,
			partial: false,
		});
	}
});
