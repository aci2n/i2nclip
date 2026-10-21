import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { createFiles } from "../src/lib/services/files.ts";
import { createChainApi } from "../src/lib/services/library-api.ts";
import { createLibraryIdentity } from "../src/lib/services/library-identity.ts";
import { createChainStorage } from "../src/lib/storage/chain.ts";
import { createChain } from "../src/lib/stores/chain.ts";

Object.assign(globalThis, { IDBKeyRange });

/** A test-owned real protocol client; no browser credentials are exported. */
export async function liveLibrary(
	origin: string,
	invitation: string,
	fetcher: typeof fetch = globalThis.fetch,
) {
	const { identity, checkpoint } = await createLibraryIdentity(
		origin,
		new AbortController().signal,
	);
	const controller = new AbortController();
	const api = createChainApi(
		origin,
		identity.signing,
		controller.signal,
		fetcher,
	);
	const cache = createChainStorage(
		origin,
		bytesToHex(identity.library),
		new IDBFactory(),
	);
	const chain = createChain(
		{
			genesis: identity.genesis,
			signing: identity.signing,
			encryption: identity.encryption,
			minimum: checkpoint,
		},
		cache,
		api,
		controller.signal,
	);
	const files = createFiles(identity.library, chain, api, controller.signal);
	function dispose() {
		controller.abort();
		identity.dispose();
		files.dispose();
		chain.dispose();
		cache.dispose();
		api.dispose();
	}
	try {
		await api.register(invitation, identity.genesis, controller.signal);
		await chain.sync();
		return {
			identity,
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
	}
}
