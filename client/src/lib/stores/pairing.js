import { writable } from "svelte/store";

export function createPairing(client) {
	const state = writable({
		active: false,
		code: "",
		verificationCode: "",
		status: "",
		remaining: 0,
		error: false,
		canControl: false,
	});
	let disposed = false;
	const unsubscribe = client.subscribe((value) =>
		state.set({
			...value.pairing,
			canControl: value.pairing.owner === value.clientId,
		}),
	);
	async function action(name, payload) {
		try {
			await client.command(`pairing.${name}`, payload);
		} catch (error) {
			if (!disposed)
				state.update((value) => ({
					...value,
					status: error.message,
					error: true,
				}));
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
			disposed = true;
			unsubscribe();
		},
	};
}
