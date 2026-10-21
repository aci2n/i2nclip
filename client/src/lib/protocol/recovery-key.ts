import {
	type Bytes,
	fixedBytes,
	genesisHash,
	safeInteger,
	sameBytes,
} from "./chain.ts";
import { loadSigningKey, type SigningKey } from "./crypto.ts";
import { generatePrivateKey, type PrivateKeyDocument } from "./identity.ts";
import { decode, encode } from "./msgpack.ts";
import { passwordOpen, passwordSeal } from "./password.ts";
import { checkServer } from "./server.ts";

export const MAX_RECOVERY_FILE_BYTES = 1024 * 1024;
export interface RecoveryGenesis {
	readonly bytes: Bytes;
	readonly hash: Bytes;
	readonly recoveryPublicKey: Bytes;
	readonly initialDevicePublicKey: Bytes;
	readonly epochSalt: Bytes;
}
export interface RecoveryIdentity {
	readonly serverUrl: string;
	readonly genesis: Bytes;
	readonly library: Bytes;
	readonly signingKey: PrivateKeyDocument;
	readonly epochDerivationSecret: Bytes;
}
export interface LoadedRecovery {
	readonly identity: RecoveryIdentity;
	readonly genesis: RecoveryGenesis;
	readonly key: SigningKey;
}
async function derive(
	epochDerivationSecret: Bytes,
	salt: Bytes,
	info: Bytes,
): Promise<Bytes> {
	const root = fixedBytes(epochDerivationSecret);
	try {
		const material = await crypto.subtle.importKey("raw", root, "HKDF", false, [
			"deriveBits",
		]);
		return new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: "HKDF", hash: "SHA-256", salt, info },
				material,
				256,
			),
		);
	} finally {
		root.fill(0);
	}
}
export function epochKey(
	epochDerivationSecret: Bytes,
	library: Bytes,
	epoch: number,
	salt: Bytes,
): Promise<Bytes> {
	return derive(
		epochDerivationSecret,
		fixedBytes(salt),
		encode(["i2nclip/epoch-key/1", fixedBytes(library), safeInteger(epoch, 1)]),
	);
}
export async function recoveryGenesis(
	recovery: Bytes,
	device: Bytes,
	salt: Bytes,
): Promise<RecoveryGenesis> {
	const recoveryPublicKey = fixedBytes(recovery);
	const initialDevicePublicKey = fixedBytes(device);
	const epochSalt = fixedBytes(salt);
	if (sameBytes(recoveryPublicKey, initialDevicePublicKey)) {
		throw new Error(
			"Recovery authority must be separate from the initial device.",
		);
	}
	const bytes = encode([
		1,
		recoveryPublicKey,
		initialDevicePublicKey,
		epochSalt,
		1,
	]);
	return {
		bytes,
		hash: await genesisHash(bytes),
		recoveryPublicKey,
		initialDevicePublicKey,
		epochSalt,
	};
}
export async function parseRecoveryGenesis(
	input: Bytes,
): Promise<RecoveryGenesis> {
	if (!(input instanceof Uint8Array) || input.length > 256) {
		throw new Error("Invalid recovery genesis.");
	}
	const value = decode(input);
	if (
		!Array.isArray(value) ||
		value.length !== 5 ||
		value[0] !== 1 ||
		value[4] !== 1
	) {
		throw new Error("Invalid recovery genesis.");
	}
	const result = await recoveryGenesis(
		fixedBytes(value[1]),
		fixedBytes(value[2]),
		fixedBytes(value[3]),
	);
	if (!sameBytes(input, result.bytes)) {
		throw new Error("Noncanonical recovery genesis.");
	}
	return result;
}
export async function loadRecovery(
	value: RecoveryIdentity,
): Promise<LoadedRecovery> {
	checkServer(value.serverUrl);
	if (new URL(value.serverUrl).origin !== value.serverUrl) {
		throw new Error("Recovery server must be a normalized origin.");
	}
	const genesis = await parseRecoveryGenesis(value.genesis);
	if (!sameBytes(genesis.hash, fixedBytes(value.library))) {
		throw new Error("Recovery genesis does not match the library.");
	}
	const epochDerivationSecret = fixedBytes(value.epochDerivationSecret);
	let signingKey: PrivateKeyDocument | undefined;
	try {
		const key = await loadSigningKey(value.signingKey);
		signingKey = {
			v: 1,
			seed: fixedBytes(value.signingKey.seed),
			public_key: key.publicKey.slice(),
		};
		if (!sameBytes(key.publicKey, genesis.recoveryPublicKey)) {
			throw new Error("Recovery key does not match the genesis authority.");
		}
		return {
			identity: {
				serverUrl: value.serverUrl,
				genesis: genesis.bytes,
				library: genesis.hash,
				signingKey,
				epochDerivationSecret,
			},
			genesis,
			key,
		};
	} catch (error) {
		epochDerivationSecret.fill(0);
		signingKey?.seed.fill(0);
		throw error;
	}
}
export async function createLibraryRecovery(
	server: string,
	initialDevicePublicKey: Bytes,
) {
	checkServer(server);
	const { privateKey: signingKey } = await generatePrivateKey();
	const epochDerivationSecret = crypto.getRandomValues(new Uint8Array(32));
	try {
		const signing = await loadSigningKey(signingKey);
		const genesis = await recoveryGenesis(
			signing.publicKey,
			initialDevicePublicKey,
			crypto.getRandomValues(new Uint8Array(32)),
		);
		const recovery = await loadRecovery({
			serverUrl: new URL(server).origin,
			genesis: genesis.bytes,
			library: genesis.hash,
			signingKey,
			epochDerivationSecret,
		});
		return {
			recovery,
			epochKey: await epochKey(
				epochDerivationSecret,
				genesis.hash,
				1,
				genesis.epochSalt,
			),
		};
	} finally {
		epochDerivationSecret.fill(0);
		signingKey?.seed.fill(0);
	}
}
export async function exportRecoveryFile(
	identity: RecoveryIdentity,
	password: string,
): Promise<Bytes> {
	if (password.length < 8) {
		throw new Error("Recovery-file password is too short.");
	}
	const validated = await loadRecovery(identity);
	const plaintext = encode([
		1,
		validated.identity.serverUrl,
		validated.identity.genesis,
		validated.identity.library,
		[
			validated.identity.signingKey.seed,
			validated.identity.signingKey.public_key,
		],
		validated.identity.epochDerivationSecret,
	]);
	try {
		if (plaintext.length > MAX_RECOVERY_FILE_BYTES - 256) {
			throw new Error("Recovery file exceeds the supported limit.");
		}
		return encode([
			"i2nclip-library-recovery",
			1,
			await passwordSeal(plaintext, password, "i2nclip/library-recovery/1"),
		]);
	} finally {
		plaintext.fill(0);
		validated.identity.epochDerivationSecret.fill(0);
		validated.identity.signingKey.seed.fill(0);
	}
}
export async function openRecoveryFile(
	input: Bytes,
	password: string,
): Promise<LoadedRecovery> {
	if (
		!(input instanceof Uint8Array) ||
		input.length > MAX_RECOVERY_FILE_BYTES
	) {
		throw new Error("Recovery file exceeds the supported limit.");
	}
	const file = decode(input);
	if (
		!Array.isArray(file) ||
		file.length !== 3 ||
		file[0] !== "i2nclip-library-recovery" ||
		file[1] !== 1 ||
		!sameBytes(input, encode(file))
	) {
		throw new Error("Invalid recovery file.");
	}
	const plaintext = await passwordOpen(
		file[2],
		password,
		"i2nclip/library-recovery/1",
	);
	try {
		const frame = decode(plaintext);
		if (
			!Array.isArray(frame) ||
			frame.length !== 6 ||
			frame[0] !== 1 ||
			typeof frame[1] !== "string" ||
			!(frame[2] instanceof Uint8Array) ||
			!sameBytes(plaintext, encode(frame))
		) {
			throw new Error("Invalid recovery credentials.");
		}
		if (!Array.isArray(frame[4]) || frame[4].length !== 2) {
			throw new Error("Invalid recovery signing credentials.");
		}
		const signingKey: PrivateKeyDocument = {
			v: 1,
			seed: fixedBytes(frame[4][0]),
			public_key: fixedBytes(frame[4][1]),
		};
		let epochDerivationSecret: Bytes | undefined;
		try {
			epochDerivationSecret = fixedBytes(frame[5]);
			return await loadRecovery({
				serverUrl: frame[1],
				genesis: new Uint8Array(frame[2]),
				library: fixedBytes(frame[3]),
				signingKey,
				epochDerivationSecret,
			});
		} finally {
			epochDerivationSecret?.fill(0);
			signingKey.seed.fill(0);
		}
	} finally {
		plaintext.fill(0);
	}
}
