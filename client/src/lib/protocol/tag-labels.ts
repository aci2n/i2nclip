import { b64urlToBytes, bytesToB64url, utf8 } from "./bytes.ts";
import type { LoadedKey } from "./crypto.ts";
import { decrypt, encrypt, tagToken } from "./crypto.ts";
import { normalizeTag, uniqueTags } from "./tags.ts";
import { document } from "./value.ts";
export type SealedTag = {
	token: Uint8Array<ArrayBuffer>;
	label: Uint8Array<ArrayBuffer>;
};

export function tagLabelAad(token: string) {
	return utf8(`i2nclip/v1 tag ${token}`);
}

export async function sealTags(key: LoadedKey, tags: unknown) {
	const unique = uniqueTags(tags);
	if (unique.length > 64) {
		throw new Error("Too many tags (maximum 64).");
	}
	return Promise.all(
		unique.map(async (tag) => {
			const token = await tagToken(key, tag);
			const label = await encrypt(key, tagLabelAad(token), utf8(tag));
			return { token: b64urlToBytes(token), label };
		}),
	);
}

export async function openTag(key: LoadedKey, input: unknown) {
	const { token, label } = document(input);
	if (
		!(token instanceof Uint8Array) ||
		token.length !== 32 ||
		!(label instanceof Uint8Array)
	) {
		throw new Error("Invalid tag record.");
	}
	const tokenText = bytesToB64url(token);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(
		await decrypt(key, tagLabelAad(tokenText), label),
	);
	normalizeTag(text);
	if (text !== text.trim() || (await tagToken(key, text)) !== tokenText) {
		throw new Error("Tag label does not match its token.");
	}
	return text;
}
