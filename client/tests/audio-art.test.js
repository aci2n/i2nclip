import assert from "node:assert/strict";
import test from "node:test";

import { audioArt } from "../src/lib/audio-art.js";

test("reads an ID3 cover and ignores a file with none", () => {
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
	const frame = apic(jpeg);
	const tag = id3(frame);
	assert.deepEqual(audioArt(tag), jpeg);
	assert.equal(
		audioArt(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 0])),
		null,
	);
});

function apic(image) {
	const mime = ascii("image/jpeg");
	const body = new Uint8Array(1 + mime.length + 1 + 1 + 1 + image.length);
	body[0] = 0;
	body.set(mime, 1);
	body[1 + mime.length] = 0;
	body[2 + mime.length] = 3;
	body[3 + mime.length] = 0;
	body.set(image, 4 + mime.length);
	const frame = new Uint8Array(10 + body.length);
	frame.set(ascii("APIC"));
	frame[4] = (body.length >>> 24) & 0xff;
	frame[5] = (body.length >>> 16) & 0xff;
	frame[6] = (body.length >>> 8) & 0xff;
	frame[7] = body.length & 0xff;
	frame.set(body, 10);
	return frame;
}

function id3(frame) {
	const out = new Uint8Array(10 + frame.length);
	out.set(ascii("ID3"));
	out[3] = 3;
	const size = frame.length;
	out[6] = (size >>> 21) & 0x7f;
	out[7] = (size >>> 14) & 0x7f;
	out[8] = (size >>> 7) & 0x7f;
	out[9] = size & 0x7f;
	out.set(frame, 10);
	return out;
}

function ascii(value) {
	return Uint8Array.from(value, (ch) => ch.charCodeAt(0));
}
