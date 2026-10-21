import { createChainApi } from "./chain-api.ts";
import { createChainStorage } from "./chain-storage.ts";
import { bytesToHex } from "./protocol/bytes.ts";
import { type Bytes, createRecord } from "./protocol/chain.ts";
import { decodeDevice, encodeDevice } from "./protocol/device.ts";
import { generateDeviceEncryptionKey } from "./protocol/device-encryption.ts";
import { generatePrivateKey } from "./protocol/identity.ts";
import { epochKey, type LoadedRecovery } from "./protocol/recovery-key.ts";
import { createChain, stateCheckpoint } from "./stores/chain.ts";

/** Session-owned operation: verify/decrypt complete history before preparing a reset. */
export function prepareRecoveryDevice(
	recovery: LoadedRecovery,
	signal: AbortSignal,
) {
	return new RecoveryReplay(recovery, signal).prepare();
}
class RecoveryReplay {
	private readonly secrets = new Map<number, Bytes>();
	private readonly recovery: LoadedRecovery;
	private readonly signal: AbortSignal;
	constructor(recovery: LoadedRecovery, signal: AbortSignal) {
		this.recovery = recovery;
		this.signal = signal;
	}

	private readonly derive = this.deriveEpoch.bind(this);
	private async deriveEpoch(epoch: number, salt: Bytes) {
		this.signal.throwIfAborted();
		const existing = this.secrets.get(epoch);
		if (existing) {
			return existing;
		}
		const secret = await epochKey(
			this.recovery.identity.epochDerivationSecret,
			this.recovery.genesis.hash,
			epoch,
			salt,
		);
		if (this.signal.aborted) {
			secret.fill(0);
			this.signal.throwIfAborted();
		}
		this.secrets.set(epoch, secret);
		return secret;
	}
	async prepare() {
		const { identity, genesis, key } = this.recovery;
		const signal = this.signal;
		signal.throwIfAborted();
		const api = createChainApi(identity.serverUrl, key, signal);
		const cache = createChainStorage(
			identity.serverUrl,
			bytesToHex(genesis.hash),
		);
		const chain = createChain(
			{
				genesis: genesis.bytes,
				publicKey: key.publicKey,
				signingKey: key.privateCryptoKey,
				secrets: this.secrets,
				minimum: { sequence: 0, hash: bytesToHex(genesis.hash) },
				recoverEpoch: this.derive,
			},
			cache,
			api,
			signal,
		);
		try {
			await this.derive(1, genesis.epochSalt);
			const state = await chain.sync();
			signal.throwIfAborted();
			const { privateKey } = await generatePrivateKey();
			const encryption = await generateDeviceEncryptionKey();
			const salt = crypto.getRandomValues(new Uint8Array(32));
			let secret: Bytes | undefined;
			let encoded: Bytes | undefined;
			try {
				secret = await epochKey(
					identity.epochDerivationSecret,
					state.library,
					state.epoch + 1,
					salt,
				);
				const record = await createRecord(
					{
						library: state.library,
						sequence: state.sequence + 1,
						previous: state.head,
						epoch: state.epoch,
						signer: key.publicKey,
						kind: "rotate",
						effects: [state.epoch + 1, privateKey.public_key, salt],
					},
					key.privateCryptoKey,
				);
				signal.throwIfAborted();
				encoded = encodeDevice({
					serverUrl: identity.serverUrl,
					genesis: genesis.bytes,
					library: state.library,
					privateKey,
					encryption,
					epochs: [...this.secrets.entries()],
					head: stateCheckpoint(state),
					phase: "resetting",
					rotation: { replacement: privateKey, secret, record: record.bytes },
				});
				return await decodeDevice(encoded);
			} finally {
				secret?.fill(0);
				privateKey.seed.fill(0);
				encryption.secret.fill(0);
				encoded?.fill(0);
			}
		} finally {
			chain.dispose();
			cache.dispose();
			api.dispose();
			for (const secret of this.secrets.values()) {
				secret.fill(0);
			}
			this.secrets.clear();
		}
	}
}
