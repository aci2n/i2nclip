import { encode as pack, decode as unpack } from "@msgpack/msgpack";

export const CONTENT_TYPE = "application/msgpack";

export function encode(value) {
	return pack(value);
}

export function decode(bytes) {
	return unpack(bytes, {
		maxStrLength: bytes.length,
		maxBinLength: bytes.length,
		maxArrayLength: bytes.length,
		maxMapLength: bytes.length,
		maxExtLength: 0,
	});
}
