import assert from "node:assert/strict";
import { get } from "svelte/store";
import type { Bytes } from "../src/lib/protocol/chain.ts";
import { verifyRecord } from "../src/lib/protocol/chain.ts";
import {
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import type { DeviceIdentity } from "../src/lib/protocol/device.ts";
import { createLibraryDevice } from "../src/lib/protocol/device.ts";
import type { Session } from "../src/lib/stores/identity.ts";
export async function createDevice(server: string) {
	const created = await createLibraryDevice(server);
	return { ...created.device, recovery: created.recovery };
}
const registrations = new WeakMap<Session, Bytes>();
export async function sessionEnrollment(session: Session) {
	const bytes = registrations.get(session);
	assert(bytes);
	return verifyRecord(bytes);
}
export async function initialDeviceState(identity: DeviceIdentity) {
	assert(identity.registration);
	return reduceBlock(
		await initialChainState(identity.genesis),
		await verifyRecord(identity.registration),
	);
}
export async function initialSessionState(session: Session) {
	return reduceBlock(
		await initialChainState(session.device().identity.genesis),
		await sessionEnrollment(session),
	);
}
export async function registerSession(
	session: Session,
	options: { serverUrl: string; otc: string },
) {
	if (!get(session).prepared && !get(session).configured) {
		if (!(await session.prepareCreation(options.serverUrl))) {
			return false;
		}
	}
	if (get(session).recoveryFile && !get(session).recoveryDownloaded) {
		if (!(await session.downloadRecovery())) {
			return false;
		}
	}
	const registration = session.device().identity.registration;
	if (registration) {
		registrations.set(session, registration.slice());
	}
	return session.create(options);
}
