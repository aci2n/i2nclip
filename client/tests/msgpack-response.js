import { CONTENT_TYPE, encode } from "../src/lib/protocol/msgpack.js";

export function documentResponse(value, options = {}) {
	return new Response(encode(value), {
		...options,
		headers: { "content-type": CONTENT_TYPE, ...options.headers },
	});
}
