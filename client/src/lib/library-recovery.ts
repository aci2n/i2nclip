import { createChainApi } from "./chain-api.ts";
import { createChainStorage } from "./chain-storage.ts";
import { bytesToHex, hexToBytes } from "./protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	MAX_AUTHORIZED_DEVICES,
} from "./protocol/chain.ts";
import {
	decodeDevice,
	encodeDevice,
	type LoadedDevice,
} from "./protocol/device.ts";
import { generateDeviceEncryptionKey } from "./protocol/device-encryption.ts";
import { generatePrivateKey } from "./protocol/identity.ts";
import { epochKey, type LoadedRecovery } from "./protocol/recovery-key.ts";
import { createChain, stateCheckpoint } from "./stores/chain.ts";

export interface RecoveryRevocation {
	readonly publicKey: string;
	readonly save: (device: LoadedDevice) => Promise<void>;
}

/** Session-owned operation: verify/decrypt complete history before preparing recovery enrollment. */
export function prepareRecoveryDevice(
	recovery: LoadedRecovery,
	signal: AbortSignal,
	revocation?: RecoveryRevocation,
) {
	return new RecoveryReplay(recovery, signal).prepare(revocation);
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
	async prepare(revocation?: RecoveryRevocation) {
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
			let state = await chain.sync();
			const target = revocation?.publicKey.trim().toLowerCase();
			if (
				target &&
				(!/^[0-9a-f]{64}$/.test(target) ||
					state.devices.get(target)?.revokedAt !== null)
			) {
				throw new Error(
					"Choose an active device by its full signing public key.",
				);
			}
			if (
				!target &&
				[...state.devices.values()].filter(
					(device) => device.revokedAt === null,
				).length >= MAX_AUTHORIZED_DEVICES
			) {
				throw new Error(
					"The library has 128 authorized devices. Explicitly revoke one device before enrollment.",
				);
			}
			signal.throwIfAborted();
			const { privateKey } = await generatePrivateKey();
			const encryption = await generateDeviceEncryptionKey();
			let encoded: Bytes | undefined;
			try {
				const candidate = async () => {
					const record = await createRecord(
						{
							library: state.library,
							sequence: state.sequence + 1,
							previous: state.head,
							epoch: state.epoch,
							signer: key.publicKey,
							kind: "enroll",
							effects: [privateKey.public_key, encryption.publicKey],
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
						phase: "recovering",
						rotation: null,
						registration: null,
						recovery: record.bytes,
					});
					return await decodeDevice(encoded);
				};
				const pending = await candidate();
				if (!target || !revocation) {
					return pending;
				}
				await revocation.save(pending);
				signal.throwIfAborted();
				state = await chain.append({
					expected: stateCheckpoint(state),
					kind: "revoke",
					effects: [hexToBytes(target)],
				});
				encoded?.fill(0);
				return await candidate();
			} finally {
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
