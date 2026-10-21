import { bytesToB64url, bytesToHex, utf8 } from "./bytes.ts";
export interface SigningKey {
	readonly privateCryptoKey: CryptoKey;
	readonly publicKey: Uint8Array<ArrayBuffer>;
	readonly registrationKey: string;
}
interface RequestContext {
	origin: string;
	ts: number;
	nonce: string;
	method: string;
	path: string;
}
interface RequestMessage extends RequestContext {
	hash: string;
}

export async function bodyHash(body: Uint8Array<ArrayBuffer>) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
	return bytesToHex(digest);
}

export function requestMessage({
	origin,
	ts,
	nonce,
	method,
	path,
	hash,
}: RequestMessage) {
	return utf8(
		`i2nclip-auth-v1\n${origin}\n${ts}\n${nonce}\n${method}\n${path}\n${hash}\n`,
	);
}

export async function authorizationHeader({
	key,
	origin,
	ts,
	nonce,
	method,
	path,
	body,
}: RequestContext & {
	key: SigningKey;
	body?: Uint8Array<ArrayBuffer>;
}) {
	const hash = await bodyHash(body ?? new Uint8Array());
	const request = requestMessage({ origin, ts, nonce, method, path, hash });
	const { privateCryptoKey, publicKey } = key;
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: "Ed25519" }, privateCryptoKey, request),
	);
	return `Bearer ${bytesToB64url(publicKey)}.${ts}.${nonce}.${hash}.${bytesToB64url(signature)}`;
}

export function freshNonce() {
	return bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
}
