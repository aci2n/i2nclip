import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type BlockHeader,
	type Bytes,
	createRecord,
	decryptOperation,
	type StorageEffect,
} from "../src/lib/protocol/chain.ts";
import {
	type ChainState,
	decodeOperation,
	encodeOperation,
	type FileOperation,
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import { loadSigningKey } from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { createLibraryRecovery } from "../src/lib/protocol/recovery-key.ts";

const filled = (value: number): Bytes => new Uint8Array(32).fill(value);
const reference = (value: number) => ({
	hash: filled(value),
	key: filled(value + 1),
});
async function device() {
	return loadSigningKey((await generatePrivateKey()).privateKey);
}
async function fixture() {
	const first = await device();
	const secret = filled(9);
	const recovery = await createLibraryRecovery(
		"https://example.test",
		first.publicKey,
		first.publicKey,
	);
	const initial = reduceBlock(
		await initialChainState(recovery.recovery.genesis.bytes),
		recovery.enrollment,
	);
	function header(state: ChainState, signer = first): BlockHeader {
		return {
			library: state.library,
			sequence: state.sequence + 1,
			previous: state.head,
			epoch: state.epoch,
			signer: signer.publicKey,
			kind: "data",
			effects: [],
		};
	}
	async function data(
		state: ChainState,
		operation: FileOperation,
		effects: readonly StorageEffect[] = [],
		signer = first,
	) {
		const plaintext = encodeOperation(operation);
		const block = await createRecord(
			{ ...header(state, signer), effects },
			signer.privateCryptoKey,
			{ secret, plaintext },
		);
		return { block, plaintext, state: reduceBlock(state, block, plaintext) };
	}
	async function admin(
		state: ChainState,
		kind: "enroll" | "revoke" | "rotate",
		target: Bytes,
		signer = kind === "rotate" ? recovery.recovery.key : first,
		epoch = state.epoch + 1,
	) {
		return createRecord(
			{
				...header(state, signer),
				kind,
				effects:
					kind === "rotate"
						? [
								epoch,
								filled(12),
								[...state.devices.values()]
									.filter((device) => device.revokedAt === null)
									.sort((a, b) =>
										bytesToHex(a.publicKey).localeCompare(
											bytesToHex(b.publicKey),
										),
									)
									.map(
										(device) =>
											[
												device.publicKey,
												filled(7),
												new Uint8Array(48),
											] as const,
									),
							]
						: kind === "enroll"
							? [target, target]
							: [target],
			},
			signer.privateCryptoKey,
		);
	}
	return { first, secret, initial, header, data, admin, recovery };
}

test("file operations deterministically replay without fetching objects or mutating prior states", async () => {
	const f = await fixture();
	const id = filled(1);
	const added = await f.data(
		f.initial,
		{ kind: "AddFile", id, manifest: reference(2), metadata: reference(4) },
		[["publish", id, filled(6)]],
	);
	const updated = await f.data(
		added.state,
		{ kind: "ReplaceMetadata", id, metadata: reference(7) },
		[["commit", id, [filled(7)]]],
	);
	const deleted = await f.data(updated.state, { kind: "DeleteFile", id });
	const restored = await f.data(deleted.state, { kind: "RestoreFile", id });
	const deletedAgain = await f.data(restored.state, { kind: "DeleteFile", id });
	const purged = await f.data(
		deletedAgain.state,
		{ kind: "PurgeFiles", ids: [id] },
		[["purge", [id]]],
	);
	const key = bytesToHex(id);
	assert.equal(f.initial.files.size, 0);
	assert.deepEqual(added.state.files.get(key)?.metadata.hash, filled(4));
	assert.equal(updated.state.files.get(key)?.deleted, false);
	assert.equal(deleted.state.files.get(key)?.deleted, true);
	assert.equal(purged.state.files.get(key)?.purged, true);
	let replay = reduceBlock(
		await initialChainState(f.recovery.recovery.genesis.bytes),
		f.recovery.enrollment,
	);
	for (const item of [
		added,
		updated,
		deleted,
		restored,
		deletedAgain,
		purged,
	]) {
		replay = reduceBlock(
			replay,
			item.block,
			await decryptOperation(item.block, f.secret),
		);
	}
	assert.deepEqual(replay, purged.state);
	await assert.rejects(
		f.data(purged.state, { kind: "RestoreFile", id }),
		/lifecycle/,
	);
	await assert.rejects(
		f.data(
			purged.state,
			{ kind: "AddFile", id, manifest: reference(2), metadata: reference(4) },
			[["publish", id, filled(6)]],
		),
		/publication/,
	);
});

test("invalid storage effects and lifecycle transitions leave the accepted state unchanged", async () => {
	const f = await fixture();
	const id = filled(1);
	const added = await f.data(
		f.initial,
		{ kind: "AddFile", id, manifest: reference(2), metadata: reference(4) },
		[["publish", id, filled(6)]],
	);
	await assert.rejects(
		f.data(added.state, { kind: "PurgeFiles", ids: [id] }, [["purge", [id]]]),
		/lifecycle/,
	);
	await assert.rejects(
		f.data(
			added.state,
			{ kind: "ReplaceMetadata", id, metadata: reference(8) },
			[["commit", id, [filled(9)]]],
		),
		/commitment/,
	);
	await assert.rejects(
		f.data(added.state, { kind: "DeleteFile", id }, [["purge", [id]]]),
		/storage effect/,
	);
	const deleted = await f.data(added.state, { kind: "DeleteFile", id });
	await assert.rejects(
		f.data(
			deleted.state,
			{ kind: "ReplaceMetadata", id, metadata: reference(8) },
			[["commit", id, [filled(8)]]],
		),
		/lifecycle/,
	);
	await assert.rejects(
		f.data(deleted.state, { kind: "PurgeFiles", ids: [id, filled(2)] }, [
			["purge", [id, filled(2)]],
		]),
		/lifecycle/,
	);
	assert.equal(deleted.state.files.get(bytesToHex(id))?.purged, false);
	assert.equal(deleted.state.sequence, f.initial.sequence + 2);
});

test("membership is checked before each operation and rotation preserves active keys", async () => {
	const f = await fixture();
	const second = await device();
	const replacement = await device();
	const enroll = await f.admin(f.initial, "enroll", second.publicKey);
	const enrolled = reduceBlock(f.initial, enroll);
	const revoke = await f.admin(enrolled, "revoke", f.first.publicKey, second);
	const revoked = reduceBlock(enrolled, revoke);
	assert.equal(
		revoked.devices.get(bytesToHex(f.first.publicKey))?.revokedAt,
		revoke.body.sequence,
	);
	const oldSigner = await f.admin(revoked, "enroll", replacement.publicKey);
	assert.throws(() => reduceBlock(revoked, oldSigner), /unauthorized/);
	const reuse = await f.admin(revoked, "enroll", f.first.publicKey, second);
	assert.throws(() => reduceBlock(revoked, reuse), /already used/);
	const last = await f.admin(revoked, "revoke", second.publicKey, second);
	assert.throws(() => reduceBlock(revoked, last), /surviving/);
	const rotate = await f.admin(
		revoked,
		"rotate",
		replacement.publicKey,
		f.recovery.recovery.key,
	);
	const rotated = reduceBlock(revoked, rotate);
	assert.equal(rotated.epoch, 2);
	assert.deepEqual(
		[...rotated.devices.values()]
			.filter((d) => d.revokedAt === null)
			.map((d) => d.publicKey),
		[second.publicKey],
	);
	assert.equal(
		enrolled.devices.get(bytesToHex(f.first.publicKey))?.revokedAt,
		null,
	);
	const wrongEpoch = await f.admin(
		revoked,
		"rotate",
		replacement.publicKey,
		f.recovery.recovery.key,
		3,
	);
	assert.throws(() => reduceBlock(revoked, wrongEpoch), /advance by one/);
});

test("forks, gaps, wrong libraries, wrong epochs and unauthorized valid signatures are rejected", async () => {
	const f = await fixture();
	const second = await device();
	for (const changes of [
		{ previous: filled(0) },
		{ sequence: f.initial.sequence + 2 },
		{ library: filled(0) },
		{ epoch: 2 },
		{ signer: second.publicKey },
	]) {
		const signer = changes.signer ? second : f.first;
		const block = await createRecord(
			{
				...f.header(f.initial),
				kind: "enroll",
				effects: [second.publicKey, second.publicKey],
				...changes,
			},
			signer.privateCryptoKey,
		);
		assert.throws(() => reduceBlock(f.initial, block));
	}
});

test("private operations require compact canonical arrays and sorted unique purge IDs", () => {
	for (const operation of [
		{ kind: "DeleteFile", id: filled(1) },
		["DeleteFile", filled(1), "extra"],
		["PurgeFiles", []],
		["PurgeFiles", [filled(2), filled(1)]],
		["PurgeFiles", [filled(1), filled(1)]],
		["unknown", filled(1)],
	]) {
		assert.throws(() => decodeOperation(encode(operation)));
	}
});

test("only the pinned recovery signer can reset and cannot acquire device authority", async () => {
	const f = await fixture();
	const next = await device();
	const deviceReset = await f.admin(
		f.initial,
		"rotate",
		next.publicKey,
		f.first,
	);
	assert.throws(() => reduceBlock(f.initial, deviceReset), /unauthorized/);
	const recoveryEnroll = await f.admin(
		f.initial,
		"enroll",
		next.publicKey,
		f.recovery.recovery.key,
	);
	assert.equal(reduceBlock(f.initial, recoveryEnroll).devices.size, 2);
	const enrollRecovery = await f.admin(
		f.initial,
		"enroll",
		f.recovery.recovery.key.publicKey,
	);
	assert.throws(() => reduceBlock(f.initial, enrollRecovery), /already used/);
	const reset = await f.admin(f.initial, "rotate", next.publicKey);
	const state = reduceBlock(f.initial, reset);
	assert.deepEqual(state.epochSalt, filled(12));
	assert.deepEqual(state.recoveryPublicKey, f.initial.recoveryPublicKey);
	assert.equal(state.devices.has(bytesToHex(next.publicKey)), false);
	assert.equal(
		state.devices.get(bytesToHex(f.first.publicKey))?.revokedAt,
		null,
	);
});

test("recovery can revoke the last device and enroll again without gaining data authority", async () => {
	const f = await fixture();
	const root = f.recovery.recovery.key;
	const revoked = reduceBlock(
		f.initial,
		await f.admin(f.initial, "revoke", f.first.publicKey, root),
	);
	assert.equal(
		[...revoked.devices.values()].filter((d) => d.revokedAt === null).length,
		0,
	);
	const next = await device();
	const restored = reduceBlock(
		revoked,
		await f.admin(revoked, "enroll", next.publicKey, root),
	);
	assert.equal(
		restored.devices.get(bytesToHex(next.publicKey))?.revokedAt,
		null,
	);
	await assert.rejects(
		f.data(restored, { kind: "DeleteFile", id: filled(1) }, [], root),
		/unauthorized/,
	);
});

test("128 active devices is the enrollment limit and revoked devices release capacity", async () => {
	const f = await fixture();
	const root = f.recovery.recovery.key;
	const members = new Map(f.initial.devices);
	for (let index = 0; members.size < 128; index++) {
		const publicKey = filled(index);
		members.set(bytesToHex(publicKey), {
			publicKey,
			encryptionPublicKey: publicKey,
			authorizedAt: 0,
			revokedAt: null,
		});
	}
	const full = { ...f.initial, devices: members };
	const next = await device();
	const enroll = await f.admin(full, "enroll", next.publicKey, root);
	assert.throws(() => reduceBlock(full, enroll), /limit/);
	const freed = reduceBlock(
		full,
		await f.admin(full, "revoke", f.first.publicKey, root),
	);
	const restored = reduceBlock(
		freed,
		await f.admin(freed, "enroll", next.publicKey, root),
	);
	assert.equal(
		[...restored.devices.values()].filter((d) => d.revokedAt === null).length,
		128,
	);
});

test("genesis has no device authority and only recovery enrollment can bootstrap it", async () => {
	const f = await fixture();
	const empty = await initialChainState(f.recovery.recovery.genesis.bytes);
	assert.equal(empty.sequence, 0);
	assert.equal(empty.devices.size, 0);
	const unsignedAuthority = await f.admin(
		empty,
		"enroll",
		f.first.publicKey,
		f.first,
	);
	assert.throws(() => reduceBlock(empty, unsignedAuthority), /first block/);
	const reset = await f.admin(empty, "rotate", (await device()).publicKey);
	assert.throws(() => reduceBlock(empty, reset), /first block/);
	const state = reduceBlock(empty, f.recovery.enrollment);
	assert.equal(
		state.devices.get(bytesToHex(f.first.publicKey))?.authorizedAt,
		1,
	);
	assert.deepEqual(state, f.initial);
});
