import { get } from "svelte/store";
import { createLibraryDevice } from "../src/lib/protocol/device.ts";
import type { Session } from "../src/lib/stores/identity.ts";
export async function createDevice(server: string) {
	const created = await createLibraryDevice(server);
	return { ...created.device, recovery: created.recovery };
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
	return session.create(options);
}
