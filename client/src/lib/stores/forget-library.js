import { get, writable } from "svelte/store";

export function createForgetLibrary(root, selected, platform) {
	const state = writable({ busy: false, error: "" });
	return {
		subscribe: state.subscribe,
		async run() {
			if (get(state).busy) {
				return false;
			}
			const libraryId = selected();
			const captured = get(root);
			if (
				!platform.confirm(
					"Forget this library and its unfinished uploads? Server files stay saved. Keep a recovery file first.",
				)
			) {
				return false;
			}
			state.set({ busy: true, error: "" });
			try {
				await root.command("libraries.forget", { libraryId });
				return true;
			} catch (error) {
				const latest = get(root);
				if (
					selected() === libraryId &&
					latest.instanceId === captured.instanceId &&
					latest.vault?.epoch === captured.vault?.epoch
				) {
					state.set({ busy: true, error: error.message });
				}
				return false;
			} finally {
				state.update((value) => ({ ...value, busy: false }));
			}
		},
		clear() {
			state.update((value) => ({ ...value, error: "" }));
		},
	};
}
