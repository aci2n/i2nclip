import { utf8 } from "./bytes.js";
import { loadKey } from "./crypto.js";
import { parsePrivateKey } from "./identity.js";
import { passwordOpen, passwordSeal } from "./password.js";
import { checkServer } from "./server.js";

export const MAX_RECOVERY_BYTES = 1024 * 1024;
function identityDocument(identity) {
	if (
		!identity ||
		typeof identity.privateKey !== "string" ||
		identity.privateKey.length > 4096
	) {
		throw new Error("Invalid library identity.");
	}
	checkServer(identity.serverUrl);
	parsePrivateKey(identity.privateKey);
	return {
		serverUrl: new URL(identity.serverUrl).origin,
		privateKey: identity.privateKey,
	};
}
export async function validateIdentity(value) {
	const identity = identityDocument(value);
	return { identity, key: await loadKey(identity.privateKey) };
}
export async function exportRecovery(identity, password) {
	if (password.length < 8) {
		throw new Error("Recovery password must be at least 8 characters.");
	}
	const value = identityDocument(identity);
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
