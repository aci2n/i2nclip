import assert from "node:assert/strict";
import type { TestContext } from "node:test";

// Scope deterministic randomness to one awaited fixture operation, including failures.
export async function withNonce<T>(
	t: TestContext,
	nonce: Uint8Array,
	operation: () => Promise<T>,
): Promise<T> {
	const mock = t.mock.method(crypto, "getRandomValues", (array: Uint8Array) => {
		assert(array instanceof Uint8Array);
		assert.equal(array.length, nonce.length);
		array.set(nonce);
		return array;
	});
	try {
		return await operation();
	} finally {
		mock.mock.restore();
	}
}
