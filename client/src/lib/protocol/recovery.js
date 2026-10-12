import { utf8 } from "./bytes.js";
import { loadKey } from "./crypto.js";
import { passwordOpen, passwordSeal } from "./password.js";
import { checkServer } from "./server.js";

export const MAX_RECOVERY_BYTES = 1024 * 1024;
export async function validateIdentity(identity) {
	if (
		!identity ||
		typeof identity.name !== "string" ||
		!identity.name.trim() ||
		identity.name.length > 80 ||
		typeof identity.privateKey !== "string" ||
		identity.privateKey.length > 4096
	) {
		throw new Error("Invalid library identity.");
	}
	checkServer(identity.serverUrl);
	await loadKey(identity.privateKey);
	return {
		name: identity.name.trim(),
		serverUrl: new URL(identity.serverUrl).origin,
		privateKey: identity.privateKey,
	};
}
export async function exportRecovery(identity, password) {
	if (password.length < 8) {
		throw new Error("Recovery password must be at least 8 characters.");
	}
	const value = await validateIdentity(identity);
	return JSON.stringify(
		{
			format: "i2nclip-recovery",
			v: 1,
			encrypted: await passwordSeal(
				utf8(JSON.stringify(value)),
				password,
				"i2nclip/recovery/1",
			),
		},
		null,
		2,
	);
}
export async function openRecovery(text, password) {
	if (typeof text !== "string" || utf8(text).length > MAX_RECOVERY_BYTES) {
		throw new Error("Recovery file is too large.");
	}
	let file;
	try {
		file = JSON.parse(text);
	} catch {
		throw new Error("Invalid recovery file.");
	}
	if (file?.format !== "i2nclip-recovery" || file.v !== 1) {
		throw new Error("Invalid recovery file.");
	}
	const bytes = await passwordOpen(
		file.encrypted,
		password,
		"i2nclip/recovery/1",
	);
	return validateIdentity(JSON.parse(new TextDecoder().decode(bytes)));
}
