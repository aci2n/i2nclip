import { get, writable } from "svelte/store";

// Only a projection and command facade; secrets and workflows belong to the owner.
export function createVault(root, platform) {
	const state = writable({ ready: false, status: "locked", epoch: 0 });
	const unsubscribe = root.subscribe((value) =>
		state.set(
			value.vault || {
				ready: Boolean(value.connected),
				status: "unlocked",
				epoch: 0,
			},
		),
	);
	let disposed = false;
	async function command(name, payload) {
		return root.command(`vault.${name}`, payload);
	}
	return {
		subscribe: state.subscribe,
		initialize: (password) => command("initialize", { password }),
		unlock: (password) => command("unlock", { password }),
		lock: () => command("lock"),
		changePassword: (currentPassword, password) =>
			command("changePassword", { currentPassword, password }),
		previewRecovery: (file, password) =>
			command("previewRecovery", { file, password }),
		importRecovery: (file, password) =>
			command("importRecovery", { file, password }),
		reset() {
			if (
				!platform.confirm(
					"Delete this client's vault, all libraries and pending uploads? Server files remain saved. You need recovery files or pairing from another client to regain access.",
				)
			) {
				return false;
			}
			return command("reset");
		},
		async exportRecovery(password, libraryId) {
			const captured = get(root);
			const blob = await command("export", { password, libraryId });
			const latest = get(root);
			if (
				disposed ||
				!latest.connected ||
				latest.instanceId !== captured.instanceId ||
				latest.vault?.epoch !== captured.vault?.epoch ||
				latest.vault?.status !== "unlocked"
			) {
				throw new Error("Vault locked. Export again after unlocking.");
			}
			const url = URL.createObjectURL(blob);
			try {
				await platform.download(
					url,
					libraryId
						? "i2nclip-library-recovery.json"
						: "i2nclip-vault-recovery.json",
				);
			} finally {
				URL.revokeObjectURL(url);
			}
		},
		dispose() {
			disposed = true;
			unsubscribe();
		},
	};
}
