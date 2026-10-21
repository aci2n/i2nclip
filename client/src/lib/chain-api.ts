import type { Checkpoint } from "./chain-storage.ts";
import { bytesToHex } from "./protocol/bytes.ts";
import {
	type Bytes,
	fixedBytes,
	MAX_BLOB_BYTES,
	MAX_BLOCK_BYTES,
	MAX_PAGE_BLOCKS,
	MAX_PAGE_BYTES,
	safeInteger,
	sameBytes,
	sha256,
} from "./protocol/chain.ts";
import {
	authorizationHeader,
	freshNonce,
	type SigningKey,
} from "./protocol/crypto.ts";
import { CONTENT_TYPE, decode, encode } from "./protocol/msgpack.ts";
import { checkServer } from "./protocol/server.ts";
import type { ChainPage, ChainTransport } from "./stores/chain.ts";

export interface StorageQuota {
	readonly maximumBytes: number;
	readonly maximumFiles: number;
	readonly usedBytes: number;
	readonly retainedFiles: number;
	readonly logBytes: number;
}
export class HttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(
			status === 409
				? "The library changed or the staged upload expired. Refresh and retry."
				: status === 401
					? "This device is not authorized. Re-pair it with an active device."
					: `Server request failed (HTTP ${status}).`,
		);
		this.status = status;
	}
}
function hashPath(value: string) {
	if (!/^[0-9a-f]{64}$/.test(value)) {
		throw new Error("Invalid object or chain address.");
	}
	return value;
}
function tuple(value: unknown, size: number): unknown[] {
	if (!Array.isArray(value) || value.length !== size) {
		throw new Error("Invalid server response frame.");
	}
	return value;
}
function checkpoint(hash: unknown, sequence: unknown): Checkpoint {
	return {
		hash: bytesToHex(fixedBytes(hash)),
		sequence: safeInteger(sequence),
	};
}
export type ChainApi = ReturnType<typeof createChainApi>;
export function createChainApi(
	server: string,
	key: SigningKey,
	signal: AbortSignal,
	fetcher: typeof fetch = globalThis.fetch,
): Pick<ChainApiImpl, keyof ChainApiImpl> {
	return new ChainApiImpl(server, key, signal, fetcher);
}
class ChainApiImpl implements ChainTransport {
	private readonly origin: string;
	private readonly key: SigningKey;
	private readonly fetcher: typeof fetch;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	readonly read = this.readPage.bind(this);
	readonly append = this.appendRecord.bind(this);
	readonly register = this.registerDevice.bind(this);
	readonly registered = this.deviceRegistered.bind(this);
	readonly quota = this.readQuota.bind(this);
	readonly putBlob = this.stageBlob.bind(this);
	readonly blob = this.readBlob.bind(this);
	readonly dispose = this.disposeApi.bind(this);
	constructor(
		server: string,
		key: SigningKey,
		signal: AbortSignal,
		fetcher: typeof fetch,
	) {
		checkServer(server);
		this.origin = new URL(server).origin;
		this.key = key;
		this.fetcher = fetcher;
		this.signal = AbortSignal.any([signal, this.controller.signal]);
	}
	private async request(
		method: string,
		path: string,
		body: Bytes | null,
		signal: AbortSignal,
	) {
		const combined = AbortSignal.any([
			this.signal,
			signal,
			AbortSignal.timeout(120_000),
		]);
		combined.throwIfAborted();
		const authorization = await authorizationHeader({
			key: this.key,
			origin: this.origin,
			ts: Math.floor(Date.now() / 1000),
			nonce: freshNonce(),
			method,
			path,
			body: body ?? undefined,
		});
		combined.throwIfAborted();
		return this.fetcher(`${this.origin}${path}`, {
			method,
			headers: {
				Authorization: authorization,
				...(body ? { "Content-Type": CONTENT_TYPE } : {}),
			},
			...(body ? { body } : {}),
			signal: combined,
			cache: "no-store",
			redirect: "error",
			credentials: "omit",
		});
	}
	private async bytes(
		response: Response,
		maximum: number,
		signal: AbortSignal,
	): Promise<Bytes> {
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Server returned an empty response.");
		}
		const chunks: Bytes[] = [];
		let total = 0;
		try {
			for (;;) {
				signal.throwIfAborted();
				this.signal.throwIfAborted();
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				total += value.length;
				if (total > maximum) {
					throw new Error("Server response exceeds the protocol limit.");
				}
				chunks.push(value);
			}
			signal.throwIfAborted();
			this.signal.throwIfAborted();
			const result = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.length;
			}
			return result;
		} catch (error) {
			await reader.cancel().catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
	}
	private async document(
		response: Response,
		maximum: number,
		signal: AbortSignal,
	) {
		if (!response.ok) {
			await response.body?.cancel();
			throw new HttpError(response.status);
		}
		const bytes = await this.bytes(response, maximum, signal);
		const value = decode(bytes);
		if (!sameBytes(bytes, encode(value))) {
			throw new Error("Noncanonical server response.");
		}
		return value;
	}
	private async readPage(
		after: string,
		until: string | null,
		signal: AbortSignal,
	): Promise<ChainPage> {
		const path = `/api/blocks?after=${hashPath(after)}${until ? `&until=${hashPath(until)}` : ""}`;
		const values = tuple(
			await this.document(
				await this.request("GET", path, null, signal),
				MAX_PAGE_BYTES,
				signal,
			),
			4,
		);
		const records = values[2];
		if (
			!Array.isArray(records) ||
			records.length > MAX_PAGE_BLOCKS ||
			records.some(
				(record) =>
					!(record instanceof Uint8Array) || record.length > MAX_BLOCK_BYTES,
			)
		) {
			throw new Error("Invalid chain page records.");
		}
		return {
			target: checkpoint(values[0], values[1]),
			records: records as Bytes[],
			next: values[3] === null ? null : bytesToHex(fixedBytes(values[3])),
		};
	}
	private async appendRecord(bytes: Bytes, signal: AbortSignal) {
		if (bytes.length > MAX_BLOCK_BYTES) {
			throw new Error("Chain record exceeds the protocol limit.");
		}
		const values = tuple(
			await this.document(
				await this.request("POST", "/api/blocks", bytes, signal),
				256,
				signal,
			),
			4,
		);
		return {
			accepted: checkpoint(values[0], values[1]),
			head: checkpoint(values[2], values[3]),
		};
	}
	private async registerDevice(
		code: string,
		recoveryPublicKey: Bytes,
		epochSalt: Bytes,
		signal: AbortSignal,
	) {
		const response = await this.request(
			"POST",
			"/api/register-key",
			encode([
				code.trim(),
				fixedBytes(recoveryPublicKey),
				fixedBytes(epochSalt),
			]),
			signal,
		);
		await response.body?.cancel();
		if (response.status !== 204) {
			throw new HttpError(response.status);
		}
	}
	private async deviceRegistered(signal: AbortSignal) {
		const response = await this.request("GET", "/api/ping", null, signal);
		await response.body?.cancel();
		if (response.status !== 204 && response.status !== 401) {
			throw new HttpError(response.status);
		}
		return response.status === 204;
	}
	private async readQuota(signal: AbortSignal): Promise<StorageQuota> {
		const values = tuple(
			await this.document(
				await this.request("GET", "/api/quota", null, signal),
				128,
				signal,
			),
			5,
		).map((value) => safeInteger(value));
		return {
			maximumBytes: values[0] as number,
			maximumFiles: values[1] as number,
			usedBytes: values[2] as number,
			retainedFiles: values[3] as number,
			logBytes: values[4] as number,
		};
	}
	private async stageBlob(file: Bytes, bytes: Bytes, signal: AbortSignal) {
		if (bytes.length < 16 || bytes.length > MAX_BLOB_BYTES) {
			throw new Error("Blob exceeds protocol bounds.");
		}
		const hash = await sha256(bytes);
		const values = tuple(
			await this.document(
				await this.request(
					"POST",
					"/api/blobs",
					encode([fixedBytes(file), bytes]),
					signal,
				),
				64,
				signal,
			),
			1,
		);
		if (!sameBytes(fixedBytes(values[0]), hash)) {
			throw new Error("Server acknowledged a different blob hash.");
		}
		return hash;
	}
	private async readBlob(
		file: string,
		hash: string,
		signal: AbortSignal,
	): Promise<Bytes> {
		const response = await this.request(
			"GET",
			`/api/blobs/${hashPath(file)}/${hashPath(hash)}`,
			null,
			signal,
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new HttpError(response.status);
		}
		const bytes = await this.bytes(response, MAX_BLOB_BYTES, signal);
		if (bytes.length < 16 || bytesToHex(await sha256(bytes)) !== hash) {
			throw new Error("Downloaded blob does not match its hash.");
		}
		return bytes;
	}
	private disposeApi() {
		this.controller.abort();
	}
}
