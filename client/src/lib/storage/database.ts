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
	let disposed = false;
	let connection: Promise<IDBDatabase> | null = null;
	const transactions = new Set<IDBTransaction>();
	function open() {
		if (disposed) {
			throw new Error("Browser storage is closed.");
		}
		if (!connection) {
			connection = new Promise<IDBDatabase>((resolve, reject) => {
				const request = factory.open(name, 1);
				let blocked = false;
				request.onupgradeneeded = () => {
					if (disposed || blocked) {
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
					if (disposed || blocked) {
						database.close();
						reject(new Error("Browser storage is closed."));
						return;
					}
					database.onversionchange = () => {
						database.close();
						connection = null;
					};
					resolve(database);
				};
			}).catch((error: unknown) => {
				connection = null;
				throw error;
			});
		}
		return connection;
	}
	async function transaction<T>(
		key: string,
		signal: AbortSignal,
		change?: (current: T | undefined) => T | undefined,
	): Promise<T | undefined> {
		signal.throwIfAborted();
		const database = await open();
		signal.throwIfAborted();
		if (disposed) {
			throw new Error("Browser storage is closed.");
		}
		return new Promise((resolve, reject) => {
			const tx = database.transaction(
				"state",
				change ? "readwrite" : "readonly",
			);
			transactions.add(tx);
			let result: T | undefined;
			let failure: unknown;
			const abort = () => tx.abort();
			signal.addEventListener("abort", abort, { once: true });
			function cleanup() {
				signal.removeEventListener("abort", abort);
				transactions.delete(tx);
			}
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
	return {
		read: (key, signal) => transaction(key, signal),
		update: (key, change, signal) => transaction(key, signal, change),
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const tx of transactions) {
				tx.abort();
			}
			void connection?.then(
				(database) => database.close(),
				() => {},
			);
		},
	};
}
