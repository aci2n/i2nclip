import { utf8 } from "./bytes.js";
import { loadKey } from "./crypto.js";
import { checkServer } from "./server.js";
import { passwordOpen, passwordSeal } from "./vault.js";
// A portable manifest has its own password, independent of any client's vault.
export const MAX_RECOVERY_BYTES = 1024 * 1024;
export async function exportRecovery(libraries, password, scope = "vault") {
	if (password.length < 8) {
		throw new Error("Recovery password must be at least 8 characters.");
	}
	if (
		!["library", "vault"].includes(scope) ||
		!libraries.length ||
		(scope === "library" && libraries.length !== 1)
	) {
		throw new Error("Choose libraries to export.");
	}
	const manifest = { v: 1, scope, libraries };
	await validateManifest(manifest);
	const bytes = utf8(JSON.stringify(manifest));
	if (bytes.length > MAX_RECOVERY_BYTES / 2) {
		throw new Error("Recovery file is too large.");
	}
	return JSON.stringify(
		{
			format: "i2nclip-recovery",
			v: 2,
			encrypted: await passwordSeal(bytes, password, "i2nclip/recovery/2"),
		},
		null,
		2,
	);
}
export async function openRecovery(text, password) {
	if (typeof text !== "string" || utf8(text).length > MAX_RECOVERY_BYTES) {
		throw new Error("Invalid recovery file.");
	}
	let file;
	try {
		file = JSON.parse(text);
	} catch {
		throw new Error("Invalid recovery file.");
	}
	if (file?.format !== "i2nclip-recovery" || file.v !== 2) {
		throw new Error("Invalid recovery file.");
	}
	const plain = await passwordOpen(
		file.encrypted,
		password,
		"i2nclip/recovery/2",
	);
	const manifest = JSON.parse(new TextDecoder().decode(plain));
	await validateManifest(manifest);
	return manifest;
}
async function validateManifest(value) {
	if (
		value?.v !== 1 ||
		!["library", "vault"].includes(value.scope) ||
		!Array.isArray(value.libraries) ||
		!value.libraries.length ||
		value.libraries.length > 1000 ||
		(value.scope === "library" && value.libraries.length !== 1)
	) {
		throw new Error("Invalid recovery manifest.");
	}
	const identities = new Set();
	for (const row of value.libraries) {
		if (
			typeof row.name !== "string" ||
			!row.name.trim() ||
			row.name.length > 80 ||
			typeof row.privateKey !== "string" ||
			row.privateKey.length > 4096
		) {
			throw new Error("Invalid recovered library.");
		}
		checkServer(row.serverUrl);
		const key = await loadKey(row.privateKey);
		const id = `${new URL(row.serverUrl).origin}:${key.registrationKey}`;
		if (identities.has(id)) {
			throw new Error("Duplicate recovered library.");
		}
		identities.add(id);
	}
}
