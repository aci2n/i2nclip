import { sniffContentType } from "../media/metadata.ts";
import { automaticTags } from "../media/tags.ts";
import { bytesToHex, hexToBytes } from "../protocol/bytes.ts";
import {
	type Bytes,
	compareBytes,
	inventoryDigest,
	openObject,
	type StorageEffect,
	sameBytes,
} from "../protocol/chain.ts";
import {
	encodeOperation,
	type FileOperation,
	type MaterializedFile,
	type ObjectReference,
} from "../protocol/chain-state.ts";
import {
	CHUNK_BYTES,
	CHUNK_TAG_BYTES,
	contentShape,
	decryptChunk,
	encryptChunk,
} from "../protocol/content.ts";
import {
	encodeFileMetadata,
	type FileManifest,
	type FileMetadata,
	manifestSize,
	newFileContent,
	openFileMetadata,
	openManifest,
	sealFileMetadata,
	sealManifest,
	sealThumbnail,
} from "../protocol/file-objects.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { uniqueTags } from "../protocol/tags.ts";
import { type Checkpoint, equalCheckpoint } from "../storage/chain.ts";
import { type ChainStore, stateCheckpoint } from "../stores/chain.ts";
import type { ChainApi } from "./library-api.ts";

export interface PreparedFileChange {
	readonly expected: Checkpoint;
	readonly operation: FileOperation;
	readonly effects: readonly StorageEffect[];
}
export interface FileUpload {
	readonly file: Blob;
	readonly attributes: Metadata;
	readonly thumbnail?: Bytes | null;
	readonly expected: Checkpoint;
	readonly signal: AbortSignal;
	readonly onProgress?: (percent: number) => void;
}
export type FileApi = Pick<ChainApi, "blob" | "putBlob" | "quota">;
export type Files = ReturnType<typeof createFiles>;
export function createFiles(
	library: Bytes,
	chain: ChainStore,
	api: FileApi,
	signal: AbortSignal,
): Pick<FilesImpl, keyof FilesImpl> {
	return new FilesImpl(library, chain, api, signal);
}
function reference(object: ObjectReference): ObjectReference {
	return { hash: object.hash, key: object.key };
}
function objectLength(plain: number) {
	const ciphertext = plain + 16;
	return 16 + (ciphertext < 256 ? 2 : ciphertext < 65_536 ? 3 : 5) + ciphertext;
}
class FilesImpl {
	private readonly library: Bytes;
	private readonly chain: ChainStore;
	private readonly api: FileApi;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	readonly upload = this.uploadFile.bind(this);
	readonly metadata = this.readMetadata.bind(this);
	readonly manifest = this.readManifest.bind(this);
	readonly thumbnail = this.readThumbnail.bind(this);
	readonly readRange = this.readContentRange.bind(this);
	readonly prepareEdit = this.prepareMetadata.bind(this);
	readonly commit = this.commitChange.bind(this);
	readonly dispose = this.disposeFiles.bind(this);
	constructor(
		library: Bytes,
		chain: ChainStore,
		api: FileApi,
		signal: AbortSignal,
	) {
		this.library = library;
		this.chain = chain;
		this.api = api;
		this.signal = AbortSignal.any([signal, this.controller.signal]);
	}
	private combined(signal: AbortSignal) {
		const combined = AbortSignal.any([this.signal, signal]);
		combined.throwIfAborted();
		return combined;
	}
	private available(file: MaterializedFile) {
		if (file.purged) {
			throw new Error(
				"This file was permanently purged. Its stored objects are unavailable.",
			);
		}
	}
	private async readMetadata(
		file: MaterializedFile,
		own: AbortSignal,
	): Promise<FileMetadata> {
		this.available(file);
		const signal = this.combined(own);
		const blob = await this.api.blob(
			bytesToHex(file.id),
			bytesToHex(file.metadata.hash),
			signal,
		);
		const value = await openFileMetadata(
			this.library,
			file.id,
			file.metadata,
			blob,
		);
		signal.throwIfAborted();
		return value;
	}
	private async readManifest(
		file: MaterializedFile,
		own: AbortSignal,
	): Promise<FileManifest> {
		this.available(file);
		const signal = this.combined(own);
		const blob = await this.api.blob(
			bytesToHex(file.id),
			bytesToHex(file.manifest.hash),
			signal,
		);
		const value = await openManifest(
			this.library,
			file.id,
			file.manifest,
			blob,
		);
		signal.throwIfAborted();
		return value;
	}
	private async readThumbnail(
		file: MaterializedFile,
		metadata: FileMetadata,
		own: AbortSignal,
	): Promise<Bytes | null> {
		this.available(file);
		const signal = this.combined(own);
		const ref = metadata.thumbnail;
		if (!ref) {
			return null;
		}
		const blob = await this.api.blob(
			bytesToHex(file.id),
			bytesToHex(ref.hash),
			signal,
		);
		const plaintext = await openObject(
			this.library,
			file.id,
			"thumbnail",
			ref.hash,
			ref.key,
			blob,
		);
		if (signal.aborted) {
			plaintext.fill(0);
			signal.throwIfAborted();
		}
		return plaintext;
	}
	private async readContentRange(
		manifest: FileManifest,
		start: number,
		end: number,
		own: AbortSignal,
	): Promise<Bytes> {
		const signal = this.combined(own);
		const { content, hashes } = manifest;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end < start ||
			end > content.size ||
			end - start > CHUNK_BYTES
		) {
			throw new Error("Invalid content range.");
		}
		const result = new Uint8Array(end - start);
		try {
			for (
				let index = Math.floor(start / CHUNK_BYTES);
				index * CHUNK_BYTES < end;
				index++
			) {
				const hash = hashes[index];
				if (!hash) {
					throw new Error("Missing content chunk hash.");
				}
				const encrypted = await this.api.blob(
					content.id,
					bytesToHex(hash),
					signal,
				);
				const plain = await decryptChunk(content, index, encrypted);
				try {
					signal.throwIfAborted();
					const offset = index * CHUNK_BYTES;
					const from = Math.max(start, offset);
					const to = Math.min(end, offset + plain.length);
					result.set(plain.subarray(from - offset, to - offset), from - start);
				} finally {
					plain.fill(0);
				}
			}
			signal.throwIfAborted();
			return result;
		} catch (error) {
			result.fill(0);
			throw error;
		}
	}
	private async uploadFile(options: FileUpload) {
		const { file, expected, onProgress } = options;
		const signal = this.combined(options.signal);
		const manifestBytes = manifestSize(file.size);
		const shape = contentShape(file.size);
		const state = await this.chain.sync();
		signal.throwIfAborted();
		if (!equalCheckpoint(stateCheckpoint(state), expected)) {
			throw new Error("The library changed. Select the file again to retry.");
		}
		const quota = await this.api.quota(signal);
		if (
			quota.retainedFiles >= quota.maximumFiles ||
			shape.encryptedBytes > quota.maximumBytes - quota.usedBytes
		) {
			throw new Error("This file exceeds the available storage quota.");
		}
		const prefix = new Uint8Array(await file.slice(0, 512).arrayBuffer());
		signal.throwIfAborted();
		const attributes: Metadata = {
			...options.attributes,
			size: file.size,
			content_type: sniffContentType(
				prefix,
				String(options.attributes.content_type ?? file.type),
			),
		};
		attributes.tags = uniqueTags([
			...uniqueTags(attributes.tags ?? []),
			...automaticTags(attributes.name ?? "", attributes.content_type ?? ""),
		]);
		const content = await newFileContent(file.size);
		const id = hexToBytes(content.content.id);
		const inventory = new Map<string, readonly [Bytes, number]>();
		const hashes: Bytes[] = [];
		const stage = async (bytes: Bytes) => {
			signal.throwIfAborted();
			const hash = await this.api.putBlob(id, bytes, signal);
			signal.throwIfAborted();
			inventory.set(bytesToHex(hash), [hash, bytes.length]);
			return hash;
		};
		try {
			let thumbnail: ObjectReference | null = null;
			const thumb = options.thumbnail?.length
				? await sealThumbnail(this.library, id, options.thumbnail)
				: null;
			if (thumb) {
				thumbnail = reference(thumb);
			}
			const metadata = { attributes, thumbnail };
			const required =
				shape.encryptedBytes +
				objectLength(manifestBytes) +
				objectLength(encodeFileMetadata(metadata).length) +
				(thumb?.bytes.length ?? 0);
			if (required > quota.maximumBytes - quota.usedBytes) {
				throw new Error(
					"Encrypted file objects exceed the available storage quota.",
				);
			}
			for (let index = 0; index < content.content.chunks; index++) {
				signal.throwIfAborted();
				const plaintext = new Uint8Array(
					await file
						.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
						.arrayBuffer(),
				);
				try {
					signal.throwIfAborted();
					const encrypted = await encryptChunk(
						content.content,
						index,
						plaintext,
					);
					if (encrypted.length !== plaintext.length + CHUNK_TAG_BYTES) {
						throw new Error("Invalid encrypted chunk size.");
					}
					hashes.push(await stage(encrypted));
				} finally {
					plaintext.fill(0);
				}
				onProgress?.(Math.round(((index + 1) / content.content.chunks) * 85));
			}
			const manifest = await sealManifest(
				this.library,
				id,
				file.size,
				content.rawKey,
				hashes,
			);
			await stage(manifest.bytes);
			if (thumb) {
				await stage(thumb.bytes);
			}
			const sealed = await sealFileMetadata(this.library, id, metadata);
			await stage(sealed.bytes);
			const digest = await inventoryDigest(this.library, id, [
				...inventory.values(),
			]);
			await this.commitChange(
				{
					expected,
					operation: {
						kind: "AddFile",
						id,
						manifest: reference(manifest),
						metadata: reference(sealed),
					},
					effects: [["publish", id, digest]],
				},
				signal,
			);
			signal.throwIfAborted();
			onProgress?.(100);
			return { id: content.content.id };
		} finally {
			content.rawKey.fill(0);
		}
	}
	private async prepareMetadata(
		file: MaterializedFile,
		attributes: Metadata,
		thumbnail: Bytes | null | undefined,
		expected: Checkpoint,
		own: AbortSignal,
	): Promise<PreparedFileChange> {
		this.available(file);
		const signal = this.combined(own);
		const state = await this.chain.sync();
		signal.throwIfAborted();
		const current = state.files.get(bytesToHex(file.id));
		if (
			!equalCheckpoint(stateCheckpoint(state), expected) ||
			!current ||
			current.deleted ||
			current.purged ||
			!sameBytes(current.metadata.hash, file.metadata.hash) ||
			!sameBytes(current.metadata.key, file.metadata.key)
		) {
			throw new Error(
				"The library changed. Review your metadata draft and retry.",
			);
		}
		const previous = await this.readMetadata(file, signal);
		let nextThumbnail = previous.thumbnail;
		const hashes: Bytes[] = [];
		if (thumbnail !== undefined) {
			nextThumbnail = null;
			if (thumbnail?.length) {
				const sealed = await sealThumbnail(this.library, file.id, thumbnail);
				hashes.push(await this.api.putBlob(file.id, sealed.bytes, signal));
				nextThumbnail = reference(sealed);
			}
		}
		const sealed = await sealFileMetadata(this.library, file.id, {
			attributes: { ...previous.attributes, ...attributes },
			thumbnail: nextThumbnail,
		});
		hashes.push(await this.api.putBlob(file.id, sealed.bytes, signal));
		signal.throwIfAborted();
		hashes.sort(compareBytes);
		return {
			expected,
			operation: {
				kind: "ReplaceMetadata",
				id: file.id,
				metadata: reference(sealed),
			},
			effects: [["commit", file.id, hashes]],
		};
	}
	private async commitChange(change: PreparedFileChange, own: AbortSignal) {
		const signal = this.combined(own);
		const plaintext = encodeOperation(change.operation);
		try {
			return await this.chain.append({
				expected: change.expected,
				effects: change.effects,
				plaintext,
				signal,
			});
		} finally {
			plaintext.fill(0);
		}
	}
	private disposeFiles() {
		this.controller.abort();
	}
}
