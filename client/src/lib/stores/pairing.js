import { writable } from "svelte/store";

export function createPairing(client) {
	const state = writable({
		active: false,
		code: "",
		verificationCode: "",
		status: "",
		remaining: 0,
		error: false,
	});
	const unsubscribe = client.subscribe((value) => state.set(value.pairing));
	async function action(name, payload) {
		try {
			return await client.command(`pairing.${name}`, payload);
		} catch {
			return false;
		}
	}
	return {
		subscribe: state.subscribe,
		send: () => action("send"),
		receive: (code, password, serverUrl) =>
			action("receive", { code, password, serverUrl }),
		approve: () => action("approve"),
		cancel: () => action("cancel"),
		rejectVerification: () => action("rejectVerification"),
		dispose() {
			unsubscribe();
		},
	};
}
