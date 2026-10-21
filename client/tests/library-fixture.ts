import { get } from "svelte/store";
import { initialChainState } from "../src/lib/protocol/chain-state.ts";
import {
	createLibraryIdentity,
	type LibraryIdentity,
} from "../src/lib/services/library-identity.ts";
import type { Session } from "../src/lib/stores/session.ts";
export async function createIdentity(server: string) {
	return (await createLibraryIdentity(server, new AbortController().signal))
		.identity;
}
export async function initialIdentityState(identity: LibraryIdentity) {
	return initialChainState(identity.genesis);
}
export async function initialSessionState(session: Session) {
	return initialChainState(session.pairingIdentity().identity.genesis);
}
export async function registerSession(
	session: Session,
	options: { serverUrl: string; otc: string },
) {
	if (
		!get(session).prepared &&
		!get(session).configured &&
		!(await session.prepareCreation(options.serverUrl))
	) {
		return false;
	}
	if (
		get(session).backup &&
		!get(session).backupDownloaded &&
		!(await session.downloadBackup())
	) {
		return false;
	}
	return session.create(options);
}
