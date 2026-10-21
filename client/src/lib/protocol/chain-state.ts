import { bytesToHex } from "./bytes.ts";
import {
	type Bytes,
	compareBytes,
	fixedBytes,
	MAX_BLOCK_BYTES,
	MAX_PURGE_FILES,
	type StorageEffect,
	sameBytes,
	type VerifiedBlock,
} from "./chain.ts";
import { decode, encode } from "./msgpack.ts";
import { parseRecoveryGenesis } from "./recovery-key.ts";

export interface ObjectReference {
	readonly hash: Bytes;
	readonly key: Bytes;
}
export type FileOperation =
	| {
			readonly kind: "AddFile";
			readonly id: Bytes;
			readonly manifest: ObjectReference;
			readonly metadata: ObjectReference;
	  }
	| {
			readonly kind: "ReplaceMetadata";
			readonly id: Bytes;
			readonly metadata: ObjectReference;
	  }
	| { readonly kind: "DeleteFile" | "RestoreFile"; readonly id: Bytes }
	| { readonly kind: "PurgeFiles"; readonly ids: readonly Bytes[] };
export interface MaterializedFile {
	readonly id: Bytes;
	readonly createdSequence: number;
	readonly manifest: ObjectReference;
	readonly metadata: ObjectReference;
	readonly deleted: boolean;
	readonly purged: boolean;
}
export interface DeviceMembership {
	readonly publicKey: Bytes;
	readonly authorizedAt: number;
	readonly revokedAt: number | null;
}
export interface ChainState {
	readonly library: Bytes;
	readonly head: Bytes;
	readonly sequence: number;
	readonly epoch: number;
	readonly recoveryPublicKey: Bytes;
	readonly epochSalt: Bytes;
	readonly devices: ReadonlyMap<string, DeviceMembership>;
	readonly files: ReadonlyMap<string, MaterializedFile>;
}
function invalid(reason: string): never {
	throw new Error(`Invalid chain operation: ${reason}.`);
}
function objectReference(input: unknown): ObjectReference {
	if (!Array.isArray(input) || input.length !== 2) {
		invalid("object reference");
	}
	return { hash: fixedBytes(input[0]), key: fixedBytes(input[1]) };
}
function referenceValues(reference: ObjectReference) {
	return [reference.hash, reference.key];
}
export function encodeOperation(operation: FileOperation): Bytes {
	switch (operation.kind) {
		case "AddFile":
			return encode([
				operation.kind,
				operation.id,
				referenceValues(operation.manifest),
				referenceValues(operation.metadata),
			]);
		case "ReplaceMetadata":
			return encode([
				operation.kind,
				operation.id,
				referenceValues(operation.metadata),
			]);
		case "DeleteFile":
		case "RestoreFile":
			return encode([operation.kind, operation.id]);
		case "PurgeFiles":
			return encode([operation.kind, operation.ids]);
	}
}
export function decodeOperation(plaintext: Bytes): FileOperation {
	if (plaintext.length > MAX_BLOCK_BYTES) {
		invalid("operation too large");
	}
	const value = decode(plaintext);
	if (!Array.isArray(value)) {
		invalid("operation array required");
	}
	let operation: FileOperation;
	if (value[0] === "AddFile" && value.length === 4) {
		operation = {
			kind: value[0],
			id: fixedBytes(value[1]),
			manifest: objectReference(value[2]),
			metadata: objectReference(value[3]),
		};
	} else if (value[0] === "ReplaceMetadata" && value.length === 3) {
		operation = {
			kind: value[0],
			id: fixedBytes(value[1]),
			metadata: objectReference(value[2]),
		};
	} else if (
		(value[0] === "DeleteFile" || value[0] === "RestoreFile") &&
		value.length === 2
	) {
		operation = { kind: value[0], id: fixedBytes(value[1]) };
	} else if (
		value[0] === "PurgeFiles" &&
		value.length === 2 &&
		Array.isArray(value[1])
	) {
		const ids = value[1].map((id: unknown) => fixedBytes(id));
		if (
			!ids.length ||
			ids.length > MAX_PURGE_FILES ||
			ids.some(
				(id, index) => index > 0 && compareBytes(ids[index - 1], id) >= 0,
			)
		) {
			invalid("purge IDs must be bounded, sorted, and unique");
		}
		operation = { kind: value[0], ids };
	} else {
		return invalid("unknown operation or invalid fields");
	}
	if (!sameBytes(encodeOperation(operation), plaintext)) {
		invalid("noncanonical operation");
	}
	return operation;
}
export async function initialChainState(
	genesisBytes: Bytes,
): Promise<ChainState> {
	const root = await parseRecoveryGenesis(genesisBytes);
	const publicKey = root.initialDevicePublicKey;
	return {
		library: root.hash,
		head: root.hash,
		sequence: 0,
		epoch: 1,
		recoveryPublicKey: root.recoveryPublicKey,
		epochSalt: root.epochSalt,
		devices: new Map([
			[bytesToHex(publicKey), { publicKey, authorizedAt: 0, revokedAt: null }],
		]),
		files: new Map(),
	};
}
function fileById(state: ChainState, id: Bytes, deleted: boolean) {
	const file = state.files.get(bytesToHex(id));
	if (!file || file.purged || file.deleted !== deleted) {
		invalid("file lifecycle transition");
	}
	return file;
}
function sameIDs(left: readonly Bytes[], right: readonly Bytes[]) {
	return (
		left.length === right.length &&
		left.every((id, index) => sameBytes(id, right[index]))
	);
}
function applyFiles(
	state: ChainState,
	record: VerifiedBlock,
	plaintext: Bytes,
) {
	const operation = decodeOperation(plaintext);
	const effects = record.body.effects as readonly StorageEffect[];
	const effect = effects[0];
	const files = new Map(state.files);
	if (operation.kind === "AddFile") {
		if (
			files.has(bytesToHex(operation.id)) ||
			effect?.[0] !== "publish" ||
			!sameBytes(effect[1], operation.id)
		) {
			invalid("file publication");
		}
		files.set(bytesToHex(operation.id), {
			id: operation.id,
			manifest: operation.manifest,
			metadata: operation.metadata,
			createdSequence: record.body.sequence,
			deleted: false,
			purged: false,
		});
	} else if (operation.kind === "ReplaceMetadata") {
		const file = fileById(state, operation.id, false);
		if (
			effect?.[0] !== "commit" ||
			!sameBytes(effect[1], operation.id) ||
			!effect[2].some((hash) => sameBytes(hash, operation.metadata.hash))
		) {
			invalid("metadata commitment");
		}
		files.set(bytesToHex(operation.id), {
			...file,
			metadata: operation.metadata,
		});
	} else if (operation.kind === "PurgeFiles") {
		if (effect?.[0] !== "purge" || !sameIDs(effect[1], operation.ids)) {
			invalid("purge effect mismatch");
		}
		for (const id of operation.ids) {
			const file = fileById(state, id, true);
			files.set(bytesToHex(id), { ...file, purged: true });
		}
	} else {
		if (effects.length) {
			invalid("unexpected storage effect");
		}
		const file = fileById(
			state,
			operation.id,
			operation.kind === "RestoreFile",
		);
		files.set(bytesToHex(operation.id), {
			...file,
			deleted: operation.kind === "DeleteFile",
		});
	}
	return files;
}

/** Pure replay of a cryptographically verified record. No object fetches or key lookup. */
export function reduceBlock(
	state: ChainState,
	record: VerifiedBlock,
	plaintext?: Bytes,
): ChainState {
	const body = record.body;
	if (
		!sameBytes(state.library, body.library) ||
		!sameBytes(state.head, body.previous) ||
		body.sequence !== state.sequence + 1 ||
		body.epoch !== state.epoch
	) {
		invalid("parent, sequence, library, or epoch mismatch");
	}
	const signer = state.devices.get(bytesToHex(body.signer));
	const recoverySigned = sameBytes(body.signer, state.recoveryPublicKey);
	if (
		body.kind === "rotate"
			? !recoverySigned
			: recoverySigned
				? body.kind === "data"
				: !signer || signer.revokedAt !== null
	) {
		invalid("unauthorized signer");
	}
	let files = state.files;
	let devices = state.devices;
	let epoch = state.epoch;
	let epochSalt = state.epochSalt;
	if (body.kind === "data") {
		if (!plaintext) {
			invalid("missing decrypted operation");
		}
		files = applyFiles(state, record, plaintext);
	} else {
		if (plaintext) {
			invalid("unexpected private operation");
		}
		const next = new Map(devices);
		if (body.kind === "revoke") {
			const key = body.effects[0] as Bytes;
			const target = devices.get(bytesToHex(key));
			if (
				!target ||
				target.revokedAt !== null ||
				(!recoverySigned &&
					[...devices.values()].filter((device) => device.revokedAt === null)
						.length <= 1)
			) {
				invalid("revocation requires an active target and surviving device");
			}
			next.set(bytesToHex(key), { ...target, revokedAt: body.sequence });
		} else {
			const key = body.effects[body.kind === "rotate" ? 1 : 0] as Bytes;
			if (
				sameBytes(key, state.recoveryPublicKey) ||
				next.has(bytesToHex(key))
			) {
				invalid("device key already used");
			}
			if (body.kind === "rotate") {
				const nextEpoch = body.effects[0] as number;
				if (nextEpoch !== epoch + 1 || !Number.isSafeInteger(nextEpoch)) {
					invalid("epoch must advance by one");
				}
				epoch = nextEpoch;
				epochSalt = fixedBytes(body.effects[2]);
				for (const [id, device] of next) {
					if (device.revokedAt === null) {
						next.set(id, { ...device, revokedAt: body.sequence });
					}
				}
			}
			if (
				[...next.values()].filter((device) => device.revokedAt === null)
					.length >= 128
			) {
				invalid("authorized device limit reached");
			}
			next.set(bytesToHex(key), {
				publicKey: key,
				authorizedAt: body.sequence,
				revokedAt: null,
			});
		}
		devices = next;
	}
	return {
		...state,
		head: record.hash,
		sequence: body.sequence,
		epoch,
		epochSalt,
		devices,
		files,
	};
}
