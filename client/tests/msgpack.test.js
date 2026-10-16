import assert from "node:assert/strict";
import test from "node:test";
import { CONTENT_TYPE, decode, encode } from "../src/lib/protocol/msgpack.js";

test("named maps and binary fields match Rust and reject incomplete or trailing documents", () => {
	const value = { v: 1, data: new Uint8Array([0, 255]) };
	const bytes = encode(value);
	assert.equal(
		Buffer.from(bytes).toString("hex"),
		"82a17601a464617461c40200ff",
	);
	assert.deepEqual(decode(bytes), value);
	assert.equal(CONTENT_TYPE, "application/msgpack");
	for (const invalid of [
		bytes.slice(0, -1),
		new Uint8Array(),
		new Uint8Array([0xc1]),
		new Uint8Array([...bytes, 0xc0]),
		new Uint8Array([...bytes, 0xc4]),
		new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff]),
	]) {
		assert.throws(() => decode(invalid));
	}
});
