import type { Database } from "../src/lib/database.ts";

// Separate connections share only this test's records; values cross a clone boundary.
export function memoryStorage() {
	const values = new Map<string, unknown>();
	return {
		values,
		connect(): Database {
			let disposed = false;
			function check(signal: AbortSignal) {
				signal.throwIfAborted();
				if (disposed) {
					throw new Error("Storage is closed.");
				}
			}
			return {
				async read<T>(key: string, signal: AbortSignal) {
					check(signal);
					return structuredClone(values.get(key)) as T | undefined;
				},
				async update<T>(
					key: string,
					change: (current: T | undefined) => T | undefined,
					signal: AbortSignal,
				) {
					check(signal);
					const next = change(
						structuredClone(values.get(key)) as T | undefined,
					);
					if (next === undefined) {
						values.delete(key);
					} else {
						values.set(key, structuredClone(next));
					}
					return next;
				},
				dispose() {
					disposed = true;
				},
			};
		},
	};
}
