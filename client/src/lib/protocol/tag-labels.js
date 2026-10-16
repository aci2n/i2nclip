import { b64urlToBytes, bytesToB64url, utf8 } from "./bytes.js";
import { decrypt, encrypt, tagToken } from "./crypto.js";
import { normalizeTag, uniqueTags } from "./tags.js";

export function tagLabelAad(token) {
	return utf8(`i2nclip/v1 tag ${token}`);
}

export async function sealTags(key, tags) {
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

export async function openTag(key, { token, label }) {
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
