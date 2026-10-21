import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import { createChainApi } from "../src/lib/chain-api.ts";
import { createChainStorage } from "../src/lib/chain-storage.ts";
import { createFiles } from "../src/lib/files.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { createLibraryDevice } from "../src/lib/protocol/device.ts";
import { createChain } from "../src/lib/stores/chain.ts";

Object.assign(globalThis, { IDBKeyRange });

/** A test-owned real protocol client; no browser credentials are exported. */
export async function liveLibrary(
	origin: string,
	invitation: string,
	fetcher: typeof fetch = globalThis.fetch,
) {
	const { device, recovery } = await createLibraryDevice(origin);
	const controller = new AbortController();
	const api = createChainApi(origin, device.key, controller.signal, fetcher);
	const cache = createChainStorage(
		origin,
		bytesToHex(device.identity.library),
		new IDBFactory(),
	);
	const chain = createChain(
		{
			genesis: device.identity.genesis,
			publicKey: device.key.publicKey,
			signingKey: device.key.privateCryptoKey,
			secrets: new Map(device.identity.epochs),
			minimum: device.identity.head,
		},
		cache,
		api,
		controller.signal,
	);
	const files = createFiles(
		device.identity.library,
		chain,
		api,
		controller.signal,
	);
	function dispose() {
		controller.abort();
		files.dispose();
		chain.dispose();
		cache.dispose();
		api.dispose();
	}
	try {
		assert(device.identity.registration);
		await api.register(
			invitation,
			device.identity.genesis,
			device.identity.registration,
			controller.signal,
		);
		await chain.sync();
		return {
			device,
			api,
			chain,
			files,
			signal: controller.signal,
			state: () => get(chain).live,
			dispose,
		};
	} catch (error) {
		dispose();
		throw error;
	} finally {
		recovery.identity.signingKey.seed.fill(0);
		recovery.identity.epochDerivationSecret.fill(0);
	}
}
