import { createChainApi } from "./chain-api.ts";
import { type Checkpoint, createChainStorage } from "./chain-storage.ts";
import { bytesToHex } from "./protocol/bytes.ts";
import type { ChainState } from "./protocol/chain-state.ts";
import type { LoadedDevice } from "./protocol/device.ts";
import { createChain } from "./stores/chain.ts";

/** An admission probe alone never establishes a restored device's authority. */
export async function verifyDevice(
	device: LoadedDevice,
	minimum: Checkpoint,
	signal: AbortSignal,
): Promise<ChainState> {
	const { identity, key } = device;
	const api = createChainApi(identity.serverUrl, key, signal);
	const storage = createChainStorage(
		identity.serverUrl,
		bytesToHex(identity.library),
	);
	const chain = createChain(
		{
			genesis: identity.genesis,
			publicKey: key.publicKey,
			signingKey: key.privateCryptoKey,
			secrets: new Map(identity.epochs),
			minimum,
		},
		storage,
		api,
		signal,
	);
	try {
		const state = await chain.sync();
		signal.throwIfAborted();
		if (state.devices.get(bytesToHex(key.publicKey))?.revokedAt !== null) {
			throw new Error(
				"This device is not authorized in the verified chain. Re-pair it with an active device.",
			);
		}
		if (state.epoch !== identity.epochs.length) {
			throw new Error(
				"This device does not have the current epoch secret. Re-pair it with an active device.",
			);
		}
		return state;
	} finally {
		chain.dispose();
		api.dispose();
	}
}
