import { get, writable } from "svelte/store";

// The review/import workflow is local UI state; decryption stays in the owner.
export function createRecoveryImport(vault, onComplete) {
	const state = writable({
		files: undefined,
		password: "",
		preview: [],
		busy: false,
		message: "",
		error: false,
	});
	let file;
	let secret = "";
	let revision = 0;
	let disposed = false;
	const update = (patch) => {
		if (!disposed) {
			state.update((value) => ({ ...value, ...patch }));
		}
	};
	function invalidate() {
		revision++;
		file = undefined;
		secret = "";
		update({ preview: [], message: "" });
	}
	return {
		subscribe: state.subscribe,
		edit(field, value) {
			if (field === "files") {
				invalidate();
			}
			update({ [field]: value });
		},
		cancel: invalidate,
		async review() {
			if (disposed || get(state).busy) {
				return;
			}
			const attempt = ++revision;
			const epoch = get(vault).epoch;
			file = get(state).files?.[0];
			secret = get(state).password;
			update({
				busy: true,
				password: "",
				error: false,
				message: "",
				preview: [],
			});
			try {
				const preview = await vault.previewRecovery(file, secret);
				if (
					attempt === revision &&
					get(vault).epoch === epoch &&
					get(vault).status === "unlocked"
				) {
					update({ preview });
				}
			} catch (error) {
				if (attempt === revision) {
					invalidate();
					update({ message: error.message, error: true });
				}
			} finally {
				update({ busy: false });
			}
		},
		async restore() {
			if (disposed || get(state).busy || !get(state).preview.length) {
				return;
			}
			const epoch = get(vault).epoch;
			update({ busy: true, error: false });
			try {
				const result = await vault.importRecovery(file, secret);
				if (get(vault).epoch !== epoch || get(vault).status !== "unlocked") {
					return;
				}
				// Import may itself replace the empty setup view before its reply arrives.
				if (result.imported[0]) {
					onComplete(result.imported[0], result);
				}
				invalidate();
				update({
					files: undefined,
					message: `Restored ${result.imported.length} libraries. ${result.skipped} already saved.`,
				});
			} catch (error) {
				update({ message: error.message, error: true });
			} finally {
				file = undefined;
				secret = "";
				update({ busy: false, preview: [] });
			}
		},
		dispose() {
			disposed = true;
			revision++;
			file = undefined;
			secret = "";
			state.set({
				files: undefined,
				password: "",
				preview: [],
				busy: false,
				message: "",
				error: false,
			});
		},
	};
}
