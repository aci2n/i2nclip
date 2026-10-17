import type { Readable } from "svelte/store";
import { get } from "svelte/store";
import type { PrivateKeyDocument } from "../protocol/identity.ts";

export interface IdentitySnapshot {
	serverUrl: string;
	publicKey: string;
	privateKey: PrivateKeyDocument | "";
	epoch: number;
	configured: boolean;
}
export interface OperationOptions {
	signal?: AbortSignal;
	onInvalidated?: () => void;
}
export interface SessionOperation {
	signal: AbortSignal;
	abort(reason?: unknown): void;
	dispose(): void;
}

const fields = [
	"serverUrl",
	"publicKey",
	"privateKey",
	"epoch",
	"configured",
] as const;
const changed = (
	a: Readonly<IdentitySnapshot>,
	b: Readonly<IdentitySnapshot>,
) => fields.some((field) => a[field] !== b[field]);
const stale = () =>
	new DOMException("Library changed. Try again.", "AbortError");

// Session-owned cancellation and identity comparison; workflows do not duplicate
// these rules. The store is a render snapshot, never the authority for a commit.
export function createSessionContext(state: Readable<IdentitySnapshot>) {
	const operations = new Set<SessionOperation>();
	return {
		invalidate() {
			for (const operation of [...operations]) {
				operation.abort(stale());
			}
		},
		operation({
			signal,
			onInvalidated,
		}: {
			signal?: AbortSignal;
			onInvalidated?: () => void;
		} = {}) {
			const expected = Object.freeze({ ...get(state) });
			const controller = new AbortController();
			const combined = signal
				? AbortSignal.any([signal, controller.signal])
				: controller.signal;
			let disposed = false;
			const operation = {
				signal: combined,
				abort(reason?: unknown) {
					if (controller.signal.aborted || disposed) {
						return;
					}
					controller.abort(reason);
					onInvalidated?.();
				},
				dispose() {
					if (disposed) {
						return;
					}
					disposed = true;
					operations.delete(operation);
					unsubscribe();
					controller.abort();
				},
			};
			const unsubscribe = state.subscribe((value) => {
				if (changed(expected, value)) {
					operation.abort(stale());
				}
			});
			operations.add(operation);
			return Object.freeze(operation);
		},
		owns: (operation: SessionOperation) => operations.has(operation),
	};
}
