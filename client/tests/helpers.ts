import type { Readable } from "svelte/store";
import { get } from "svelte/store";
import type { Media } from "../src/lib/api.ts";
import { loadKey } from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { decode } from "../src/lib/protocol/msgpack.ts";
import { bytes, document } from "../src/lib/protocol/value.ts";
import type { SessionOperation } from "../src/lib/stores/identity-context.ts";
import { createSessionContext } from "../src/lib/stores/identity-context.ts";
import type { SessionState } from "../src/lib/stores/session.ts";
export function mediaData(value: Pick<Media, "id"> & Partial<Media>): Media {
	return {
		createdAt: 0,
		bytes: 0,
		metadata: null,
		thumb: null,
		metaHash: "hash",
		...value,
	};
}

export function requestBody(options: RequestInit): Uint8Array<ArrayBuffer> {
	return bytes(options.body);
}
export function requestDocument(options: RequestInit): Record<string, unknown> {
	return document(decode(requestBody(options)));
}

export const testKey = await loadKey((await generatePrivateKey()).privateKey);

export function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));

// Pairing workflow tests use an in-memory identity context.
export function workflowSession<
	T extends Pick<
		SessionState,
		"serverUrl" | "publicKey" | "privateKey" | "epoch" | "configured"
	>,
	S extends Readable<T>,
>(store: S) {
	const context = createSessionContext(store);
	return {
		...store,
		operation: context.operation,
		async withIdentity<R>(
			operation: SessionOperation,
			action: (identity: T) => R | Promise<R>,
		) {
			operation.signal.throwIfAborted();
			return action(get(store));
		},
	};
}
