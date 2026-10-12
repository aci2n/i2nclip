import { get } from "svelte/store";

const fields = [
	"serverUrl",
	"publicKey",
	"privateKey",
	"identityGeneration",
	"configured",
];
const changed = (a, b, includeUnlocked = true) =>
	fields.some(
		(field) =>
			(includeUnlocked || field !== "privateKey") && a[field] !== b[field],
	);
const stale = () =>
	new DOMException("Library changed. Try again.", "AbortError");

// Session-owned cancellation and identity comparison; workflows do not duplicate
// these rules. The store is a render snapshot, never the authority for a commit.
export function createSessionContext(state) {
	const operations = new Set();
	const snapshots = new WeakMap();
	return {
		invalidate() {
			for (const operation of [...operations]) {
				operation.abort(stale());
			}
		},
		observe(listener, { includeUnlocked = true } = {}) {
			let previous;
			return state.subscribe((value) => {
				if (
					!value.ready ||
					(previous && !changed(previous, value, includeUnlocked))
				) {
					return;
				}
				previous = value;
				listener(Object.freeze({ ...value }));
			});
		},
		operation({ signal, onInvalidated } = {}) {
			const expected = Object.freeze({ ...get(state) });
			const controller = new AbortController();
			const combined = signal
				? AbortSignal.any([signal, controller.signal])
				: controller.signal;
			let disposed = false;
			const operation = {
				unlocked: Boolean(expected.privateKey),
				signal: combined,
				abort(reason) {
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
			snapshots.set(operation, expected);
			return Object.freeze(operation);
		},
		owns: (operation) => operations.has(operation),
		expected: (operation) => snapshots.get(operation),
		matches: (expected, current) => !changed(expected, current),
	};
}
