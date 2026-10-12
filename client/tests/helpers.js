import { createSessionContext } from "../src/lib/stores/identity-context.js";
export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));

// Pairing workflow tests use an in-memory identity context.
export function workflowSession(store) {
	const context = createSessionContext(store);
	return {
		...store,
		operation: context.operation,
		async withIdentity(operation, action) {
			operation.signal.throwIfAborted();
			return action(context.expected(operation));
		},
	};
}
