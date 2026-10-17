import { loadKey } from "./crypto.ts";
import { parsePrivateKey } from "./identity.ts";
import { decode, encode } from "./msgpack.ts";
import { passwordOpen, passwordSeal } from "./password.ts";
import { checkServer } from "./server.ts";
import { document, string } from "./value.ts";
export type Identity = Awaited<ReturnType<typeof validateIdentity>>["identity"];

export const MAX_RECOVERY_BYTES = 1024 * 1024;
function identityDocument(input: unknown) {
	const identity = document(input);
	if (!identity) {
		throw new Error("Invalid library identity.");
	}
	checkServer(string(identity.server_url));
	const parsed = parsePrivateKey(identity.private_key);
	return {
		server_url: new URL(string(identity.server_url)).origin,
		private_key: { v: 1, seed: parsed.seed, public_key: parsed.publicKey },
	};
}
export async function validateIdentity(value: unknown) {
	const identity = identityDocument(value);
	return { identity, key: await loadKey(identity.private_key) };
}
export async function exportRecovery(identity: unknown, password: string) {
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
export async function openRecovery(
	bytes: Uint8Array<ArrayBuffer>,
	password: string,
) {
	if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RECOVERY_BYTES) {
		throw new Error("Recovery file is too large.");
	}
	let file: Record<string, unknown>;
	try {
		file = document(decode(bytes));
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
