import { bytesToB64url } from "./bytes.ts";
import type { Bytes } from "./chain.ts";
import { exportRecoveryFile, type RecoveryIdentity } from "./recovery-key.ts";

export interface EncryptedBackup {
	readonly bytes: Bytes;
	readonly password: string;
}
function generatedPassword() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	try {
		return bytesToB64url(bytes);
	} finally {
		bytes.fill(0);
	}
}
export async function createRecoveryFile(
	identity: RecoveryIdentity,
): Promise<EncryptedBackup> {
	const password = generatedPassword();
	return { bytes: await exportRecoveryFile(identity, password), password };
}
