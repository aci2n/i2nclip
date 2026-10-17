import { CONTENT_TYPE, encode } from "../src/lib/protocol/msgpack.ts";
export function documentResponse(value: unknown, options: ResponseInit = {}) {
	return new Response(encode(value), {
		...options,
		headers: new Headers({
			"content-type": CONTENT_TYPE,
			...Object.fromEntries(new Headers(options.headers)),
		}),
	});
}
