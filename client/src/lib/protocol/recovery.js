import { loadKey } from "./crypto.js";
import { parsePrivateKey } from "./identity.js";
import { decode, encode } from "./msgpack.js";
import { passwordOpen, passwordSeal } from "./password.js";
import { checkServer } from "./server.js";

export const MAX_RECOVERY_BYTES = 1024 * 1024;
function identityDocument(identity) {
	if (!identity) {
		throw new Error("Invalid library identity.");
	}
	checkServer(identity.server_url);
	const parsed = parsePrivateKey(identity.private_key);
	return {
		server_url: new URL(identity.server_url).origin,
		private_key: { v: 1, seed: parsed.seed, public_key: parsed.publicKey },
	};
}
export async function validateIdentity(value) {
	const identity = identityDocument(value);
	return { identity, key: await loadKey(identity.private_key) };
}
export async function exportRecovery(identity, password) {
	if (password.length < 8) {
		throw new Error("Recovery password must be at least 8 characters.");
	}
	const value = identityDocument(identity);
	return encode({
		format: "i2nclip-recovery",
		v: 1,
		encrypted: await passwordSeal(
			encode(value),
			password,
			"i2nclip/recovery/1",
		),
	});
}
export async function openRecovery(bytes, password) {
	if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RECOVERY_BYTES) {
		throw new Error("Recovery file is too large.");
	}
	let file;
	try {
		file = decode(bytes);
	} catch {
		throw new Error("Invalid recovery file.");
	}
	if (file?.format !== "i2nclip-recovery" || file.v !== 1) {
		throw new Error("Invalid recovery file.");
	}
	const plain = await passwordOpen(
		file.encrypted,
		password,
		"i2nclip/recovery/1",
	);
	try {
		return await validateIdentity(decode(plain));
	} finally {
		plain.fill(0);
	}
}
