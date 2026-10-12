import { get, writable } from "svelte/store";

export function createPairing(client, { beforeReceive } = {}) {
	const state = writable({
		active: false,
		code: "",
		verificationCode: "",
		status: "",
		remaining: 0,
		error: false,
	});
	let disposed = false;
	const unsubscribe = client.subscribe((value) => state.set(value.pairing));
	async function action(name, payload) {
		const captured = get(client);
		try {
			if (name === "receive") await beforeReceive?.();
			return await client.command(`pairing.${name}`, payload);
		} catch (error) {
			const latest = get(client);
			if (
				disposed ||
				latest.instanceId !== captured.instanceId ||
				latest.session?.epoch !== captured.session?.epoch
			)
				return false;
			state.update((value) => ({
				...value,
				status: error.message,
				error: true,
			}));
			return false;
		}
	}
	return {
		subscribe: state.subscribe,
		send: () => action("send"),
		receive: (code, serverUrl) => action("receive", { code, serverUrl }),
		approve: () => action("approve"),
		cancel: () => action("cancel"),
		rejectVerification: () => action("rejectVerification"),
		dispose() {
			disposed = true;
			unsubscribe();
		},
	};
}
