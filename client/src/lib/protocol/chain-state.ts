import { bytesToHex } from "./bytes.ts";
import {
	type Bytes,
	fixedBytes,
	MAX_BLOCK_BYTES,
	parseGenesis,
	type StorageEffect,
	safeInteger,
	sameBytes,
	type VerifiedBlock,
} from "./chain.ts";
import { decode, encode } from "./msgpack.ts";

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
	| {
			readonly kind: "DeleteFile" | "RestoreFile" | "PurgeFile";
			readonly id: Bytes;
	  };
export interface BlockPayload {
	readonly time: number;
	readonly operation: FileOperation;
}
/** One verified block; `previous` is the metadata a ReplaceMetadata superseded. */
export interface HistoryEntry extends BlockPayload {
	readonly sequence: number;
	readonly previous: ObjectReference | null;
}
export interface MaterializedFile {
	readonly id: Bytes;
	readonly createdSequence: number;
	readonly manifest: ObjectReference;
	readonly metadata: ObjectReference;
	readonly deleted: boolean;
	readonly purged: boolean;
}
export interface ChainState {
	readonly library: Bytes;
	readonly publicKey: Bytes;
	readonly head: Bytes;
	readonly sequence: number;
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
function operationValues(operation: FileOperation): unknown[] {
	switch (operation.kind) {
		case "AddFile":
			return [
				operation.kind,
				operation.id,
				referenceValues(operation.manifest),
				referenceValues(operation.metadata),
			];
		case "ReplaceMetadata":
			return [
				operation.kind,
				operation.id,
				referenceValues(operation.metadata),
			];
		case "DeleteFile":
		case "RestoreFile":
		case "PurgeFile":
			return [operation.kind, operation.id];
	}
}
function parseOperation(value: unknown): FileOperation {
	if (!Array.isArray(value)) {
		invalid("operation array required");
	}
	if (value[0] === "AddFile" && value.length === 4) {
		return {
			kind: value[0],
			id: fixedBytes(value[1]),
			manifest: objectReference(value[2]),
			metadata: objectReference(value[3]),
		};
	}
	if (value[0] === "ReplaceMetadata" && value.length === 3) {
		return {
			kind: value[0],
			id: fixedBytes(value[1]),
			metadata: objectReference(value[2]),
		};
	}
	if (
		(value[0] === "DeleteFile" ||
			value[0] === "RestoreFile" ||
			value[0] === "PurgeFile") &&
		value.length === 2
	) {
		return { kind: value[0], id: fixedBytes(value[1]) };
	}
	return invalid("unknown operation or invalid fields");
}
/** Block plaintext: the signing client's clock in Unix milliseconds and the operation. */
export function encodeBlockPayload(payload: BlockPayload): Bytes {
	return encode([payload.time, operationValues(payload.operation)]);
}
export function decodeBlockPayload(plaintext: Bytes): BlockPayload {
	if (plaintext.length > MAX_BLOCK_BYTES) {
		invalid("operation too large");
	}
	const value = decode(plaintext);
	if (!Array.isArray(value) || value.length !== 2) {
		invalid("payload array required");
	}
	const payload = {
		time: safeInteger(value[0]),
		operation: parseOperation(value[1]),
	};
	if (!sameBytes(encodeBlockPayload(payload), plaintext)) {
		invalid("noncanonical operation");
	}
	return payload;
}
export async function initialChainState(bytes: Bytes): Promise<ChainState> {
	const root = await parseGenesis(bytes);
	return {
		library: root.hash,
		publicKey: root.publicKey,
		head: root.hash,
		sequence: 0,
		files: new Map(),
	};
}
/** The unpurged file with this deletion state, or null when a transition no longer applies. */
export function fileInState(state: ChainState, id: Bytes, deleted: boolean) {
	const file = state.files.get(bytesToHex(id));
	return file && !file.purged && file.deleted === deleted ? file : null;
}
/**
 * The operation reversing this block in the current state, or null when it no
 * longer applies. A metadata inverse names the superseded document to restore.
 */
export function inverseOperation(
	entry: HistoryEntry,
	state: ChainState,
): FileOperation | null {
	const { operation } = entry;
	switch (operation.kind) {
		case "AddFile":
		case "RestoreFile":
			return fileInState(state, operation.id, false)
				? { kind: "DeleteFile", id: operation.id }
				: null;
		case "DeleteFile":
			return fileInState(state, operation.id, true)
				? { kind: "RestoreFile", id: operation.id }
				: null;
		case "ReplaceMetadata": {
			const file = fileInState(state, operation.id, false);
			return file &&
				entry.previous &&
				sameBytes(file.metadata.hash, operation.metadata.hash)
				? {
						kind: "ReplaceMetadata",
						id: operation.id,
						metadata: entry.previous,
					}
				: null;
		}
		case "PurgeFile":
			return null;
	}
}
function fileById(state: ChainState, id: Bytes, deleted: boolean) {
	return (
		fileInState(state, id, deleted) ?? invalid("file lifecycle transition")
	);
}
function applyFiles(
	state: ChainState,
	record: VerifiedBlock,
	plaintext: Bytes,
) {
	const { operation } = decodeBlockPayload(plaintext);
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
	} else if (operation.kind === "PurgeFile") {
		if (effect?.[0] !== "purge" || !sameBytes(effect[1], operation.id)) {
			invalid("purge effect mismatch");
		}
		const file = fileById(state, operation.id, true);
		files.set(bytesToHex(operation.id), { ...file, purged: true });
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

/** Pure reduction of an already cryptographically verified operation. */
export function reduceBlock(
	state: ChainState,
	record: VerifiedBlock,
	plaintext: Bytes,
): ChainState {
	const body = record.body;
	if (
		!sameBytes(state.library, body.library) ||
		!sameBytes(state.head, body.previous) ||
		body.sequence !== state.sequence + 1
	) {
		invalid("parent, sequence, or library mismatch");
	}
	return {
		...state,
		head: record.hash,
		sequence: body.sequence,
		files: applyFiles(state, record, plaintext),
	};
}
