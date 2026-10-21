import { type Bytes, MAX_PAGE_BLOCKS, sameBytes } from "./protocol/chain.ts";

export interface Checkpoint {
	readonly sequence: number;
	readonly hash: string;
}
export interface CachedBlock extends Checkpoint {
	readonly previous: string;
	readonly bytes: Bytes;
}
export interface ChainStorage {
	ensureHead(minimum: Checkpoint, signal: AbortSignal): Promise<Checkpoint>;
	head(signal: AbortSignal): Promise<Checkpoint | null>;
	read(after: number, signal: AbortSignal): Promise<CachedBlock[]>;
	append(
		expected: Checkpoint,
		base: Checkpoint,
		blocks: readonly CachedBlock[],
		signal: AbortSignal,
	): Promise<Checkpoint>;
	clear(signal: AbortSignal): Promise<void>;
	discardRecords(signal: AbortSignal): Promise<void>;
	dispose(): void;
}
export class CacheConflict extends Error {
	constructor() {
		super("Another tab advanced the chain cache. Refresh and retry.");
	}
}
export function equalCheckpoint(left: Checkpoint, right: Checkpoint) {
	return left.sequence === right.sequence && left.hash === right.hash;
}
function checkpoint(value: unknown): Checkpoint {
	const head = value as Checkpoint;
	if (
		!head ||
		!Number.isSafeInteger(head.sequence) ||
		head.sequence < 0 ||
		!/^[0-9a-f]{64}$/.test(head.hash)
	) {
		throw new Error("Invalid trusted chain head in browser storage.");
	}
	return { sequence: head.sequence, hash: head.hash };
}

/** Separate record/head stores permit bounded replay without rewriting the log. */
export function createChainStorage(
	origin: string,
	library: string,
	factory: IDBFactory = globalThis.indexedDB,
): ChainStorage {
	return new ChainStorageImpl(origin, library, factory);
}

// Await only native IndexedDB requests inside a transaction, never crypto/network work.
function requested<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

class ChainStorageImpl implements ChainStorage {
	private readonly name: string;
	private readonly library: string;
	private readonly factory: IDBFactory;
	private connection: Promise<IDBDatabase> | null = null;
	private disposed = false;
	private readonly active = new Set<IDBTransaction>();

	readonly ensureHead = this.ensureMinimum.bind(this);
	readonly head = this.readHead.bind(this);
	readonly read = this.readBlocks.bind(this);
	readonly append = this.appendBlocks.bind(this);
	readonly clear = this.clearHistory.bind(this);
	readonly discardRecords = this.discardCachedRecords.bind(this);
	readonly dispose = this.disposeStorage.bind(this);

	constructor(origin: string, library: string, factory: IDBFactory) {
		if (!/^[0-9a-f]{64}$/.test(library)) {
			throw new Error("Invalid library identity.");
		}
		this.library = library;
		this.name = `i2nclip-chain:${new URL(origin).origin}:${library}`;
		this.factory = factory;
	}

	private abort(tx: IDBTransaction) {
		try {
			tx.abort();
		} catch {
			/* Already completed. */
		}
	}
	private open() {
		if (this.disposed) {
			throw new Error("Chain storage is closed.");
		}
		this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = this.factory.open(this.name, 1);
			let blocked = false;
			request.onupgradeneeded = () => {
				if (this.disposed || blocked) {
					request.transaction?.abort();
					return;
				}
				request.result.createObjectStore("heads");
				request.result
					.createObjectStore("blocks", { keyPath: "sequence" })
					.createIndex("hash", "hash", { unique: true });
			};
			request.onerror = () => reject(request.error);
			request.onblocked = () => {
				blocked = true;
				reject(
					new Error(
						"Chain storage is blocked. Close other app tabs and retry.",
					),
				);
			};
			request.onsuccess = () => {
				const db = request.result;
				if (this.disposed || blocked) {
					db.close();
					reject(new Error("Chain storage is closed."));
					return;
				}
				db.onversionchange = () => {
					db.close();
					this.connection = null;
				};
				resolve(db);
			};
		}).catch((error: unknown) => {
			this.connection = null;
			throw error;
		});
		return this.connection;
	}
	private async transaction<T>(
		mode: IDBTransactionMode,
		signal: AbortSignal,
		work: (tx: IDBTransaction) => Promise<T>,
	): Promise<T> {
		signal.throwIfAborted();
		const db = await this.open();
		signal.throwIfAborted();
		if (this.disposed) {
			throw new Error("Chain storage is closed.");
		}
		const tx = db.transaction(["heads", "blocks"], mode);
		this.active.add(tx);
		const cancel = () => this.abort(tx);
		signal.addEventListener("abort", cancel, { once: true });
		const complete = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () =>
				reject(
					signal.reason ??
						tx.error ??
						new Error("Chain storage transaction failed."),
				);
		});
		try {
			const [result] = await Promise.all([work(tx), complete]);
			signal.throwIfAborted();
			return result;
		} catch (error) {
			this.abort(tx);
			await complete.catch(() => {});
			throw error;
		} finally {
			this.active.delete(tx);
			signal.removeEventListener("abort", cancel);
		}
	}
	private readHead(signal: AbortSignal) {
		return this.transaction("readonly", signal, async (tx) => {
			const value = await requested(tx.objectStore("heads").get("accepted"));
			return value ? checkpoint(value) : null;
		});
	}
	private ensureMinimum(minimum: Checkpoint, signal: AbortSignal) {
		const pin = checkpoint(minimum);
		if (pin.sequence === 0 && pin.hash !== this.library) {
			throw new Error("Genesis pin does not match the library.");
		}
		return this.transaction("readwrite", signal, async (tx) => {
			const heads = tx.objectStore("heads");
			const value = await requested(heads.get("accepted"));
			if (value) {
				return checkpoint(value);
			}
			heads.put(pin, "accepted");
			return pin;
		});
	}
	private readBlocks(after: number, signal: AbortSignal) {
		return this.transaction("readonly", signal, async (tx) => {
			return (await requested(
				tx
					.objectStore("blocks")
					.getAll(IDBKeyRange.lowerBound(after, true), MAX_PAGE_BLOCKS),
			)) as CachedBlock[];
		});
	}
	private appendBlocks(
		expected: Checkpoint,
		base: Checkpoint,
		blocks: readonly CachedBlock[],
		signal: AbortSignal,
	) {
		checkpoint(expected);
		checkpoint(base);
		if (
			!blocks.length ||
			blocks.length > MAX_PAGE_BLOCKS ||
			(base.sequence === 0 && base.hash !== this.library)
		) {
			throw new Error("Invalid chain cache batch.");
		}
		let candidate = base;
		for (const block of blocks) {
			checkpoint(block);
			if (
				block.sequence !== candidate.sequence + 1 ||
				block.previous !== candidate.hash
			) {
				throw new Error("Noncontiguous chain cache batch.");
			}
			candidate = block;
		}
		return this.transaction("readwrite", signal, async (tx) => {
			const heads = tx.objectStore("heads");
			const records = tx.objectStore("blocks");
			const current = checkpoint(await requested(heads.get("accepted")));
			if (!equalCheckpoint(current, expected)) {
				throw new CacheConflict();
			}
			const cached = (await requested(
				records.getAll(
					IDBKeyRange.bound(Math.max(1, base.sequence), candidate.sequence),
				),
			)) as CachedBlock[];
			const existing = new Map(cached.map((entry) => [entry.sequence, entry]));
			if (
				base.sequence > 0 &&
				existing.get(base.sequence)?.hash !== base.hash
			) {
				throw new Error("Missing chain cache parent.");
			}
			for (const block of blocks) {
				const old = existing.get(block.sequence);
				if (
					old &&
					(old.hash !== block.hash ||
						old.previous !== block.previous ||
						!sameBytes(old.bytes, block.bytes))
				) {
					throw new Error("Conflicting cached chain record.");
				}
			}
			const crossing = blocks.find(
				(block) => block.sequence === current.sequence,
			);
			if (crossing && crossing.hash !== current.hash) {
				throw new Error("Chain does not reach the trusted head.");
			}
			if (
				candidate.sequence > current.sequence &&
				current.sequence > 0 &&
				!crossing
			) {
				const accepted = (await requested(records.get(current.sequence))) as
					| CachedBlock
					| undefined;
				if (accepted?.hash !== current.hash) {
					throw new Error("Missing trusted chain prefix.");
				}
			}
			for (const block of blocks) {
				records.put(block);
			}
			const next =
				candidate.sequence > current.sequence ? checkpoint(candidate) : current;
			heads.put(next, "accepted");
			return next;
		});
	}
	private clearHistory(signal: AbortSignal) {
		return this.transaction("readwrite", signal, async (tx) => {
			await requested(tx.objectStore("heads").clear());
			await requested(tx.objectStore("blocks").clear());
		});
	}
	private discardCachedRecords(signal: AbortSignal) {
		return this.transaction("readwrite", signal, async (tx) => {
			await requested(tx.objectStore("blocks").clear());
		});
	}
	private disposeStorage() {
		this.disposed = true;
		for (const tx of this.active) {
			this.abort(tx);
		}
		void this.connection?.then(
			(db) => db.close(),
			() => {},
		);
	}
}

/** Explicit client reset clears current-format history without deleting open databases. */
export async function clearChainCaches(
	signal: AbortSignal,
	factory: IDBFactory = globalThis.indexedDB,
) {
	if (!factory) {
		return;
	}
	signal.throwIfAborted();
	const databases = await factory.databases();
	signal.throwIfAborted();
	for (const database of databases) {
		const match = /^i2nclip-chain:(.+):([0-9a-f]{64})$/.exec(
			database.name ?? "",
		);
		if (!match) {
			continue;
		}
		const storage = createChainStorage(match[1], match[2], factory);
		try {
			await storage.clear(signal);
		} finally {
			storage.dispose();
		}
	}
}
