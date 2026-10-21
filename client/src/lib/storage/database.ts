export interface Database {
	read<T>(key: string, signal: AbortSignal): Promise<T | undefined>;
	update<T>(
		key: string,
		change: (current: T | undefined) => T | undefined,
		signal: AbortSignal,
	): Promise<T | undefined>;
	dispose(): void;
}

// Callbacks run synchronously inside a transaction; crypto belongs outside it.
export function createDatabase(
	factory: IDBFactory = globalThis.indexedDB,
	name = "i2nclip",
): Database {
	return new DatabaseImpl(factory, name);
}
class DatabaseImpl implements Database {
	private disposed = false;
	private connection: Promise<IDBDatabase> | null = null;
	private readonly transactions = new Set<IDBTransaction>();
	private readonly factory: IDBFactory;
	private readonly name: string;
	readonly read = this.readValue.bind(this);
	readonly update = this.updateValue.bind(this);
	readonly dispose = this.disposeDatabase.bind(this);
	constructor(factory: IDBFactory, name: string) {
		this.factory = factory;
		this.name = name;
	}
	private open() {
		if (this.disposed) {
			throw new Error("Browser storage is closed.");
		}
		if (!this.connection) {
			this.connection = new Promise<IDBDatabase>((resolve, reject) => {
				const request = this.factory.open(this.name, 1);
				let blocked = false;
				request.onupgradeneeded = () => {
					if (this.disposed || blocked) {
						request.transaction?.abort();
						return;
					}
					request.result.createObjectStore("state");
				};
				request.onerror = () => reject(request.error);
				request.onblocked = () => {
					blocked = true;
					reject(
						new Error(
							"Browser storage is blocked. Close other app tabs and retry.",
						),
					);
				};
				request.onsuccess = () => {
					const database = request.result;
					if (this.disposed || blocked) {
						database.close();
						reject(new Error("Browser storage is closed."));
						return;
					}
					database.onversionchange = () => {
						database.close();
						this.connection = null;
					};
					resolve(database);
				};
			}).catch((error: unknown) => {
				this.connection = null;
				throw error;
			});
		}
		return this.connection;
	}
	private async transaction<T>(
		key: string,
		signal: AbortSignal,
		change?: (current: T | undefined) => T | undefined,
	): Promise<T | undefined> {
		signal.throwIfAborted();
		const database = await this.open();
		signal.throwIfAborted();
		if (this.disposed) {
			throw new Error("Browser storage is closed.");
		}
		return new Promise((resolve, reject) => {
			const tx = database.transaction(
				"state",
				change ? "readwrite" : "readonly",
			);
			this.transactions.add(tx);
			let result: T | undefined;
			let failure: unknown;
			const abort = () => tx.abort();
			signal.addEventListener("abort", abort, { once: true });
			const cleanup = () => {
				signal.removeEventListener("abort", abort);
				this.transactions.delete(tx);
			};
			tx.oncomplete = () => {
				cleanup();
				resolve(result);
			};
			tx.onabort = () => {
				cleanup();
				reject(
					failure ??
						signal.reason ??
						tx.error ??
						new Error("Browser storage transaction failed."),
				);
			};
			const store = tx.objectStore("state");
			const request = store.get(key);
			request.onsuccess = () => {
				try {
					signal.throwIfAborted();
					result = request.result as T | undefined;
					if (change) {
						result = change(result);
						if (result === undefined) {
							store.delete(key);
						} else {
							store.put(result, key);
						}
					}
				} catch (error) {
					failure = error;
					tx.abort();
				}
			};
		});
	}
	private readValue<T>(key: string, signal: AbortSignal) {
		return this.transaction<T>(key, signal);
	}
	private updateValue<T>(
		key: string,
		change: (current: T | undefined) => T | undefined,
		signal: AbortSignal,
	) {
		return this.transaction<T>(key, signal, change);
	}
	private disposeDatabase() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const tx of this.transactions) {
			tx.abort();
		}
		void this.connection?.then(
			(database) => database.close(),
			() => {},
		);
	}
}
