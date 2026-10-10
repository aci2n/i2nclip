import { get, writable } from "svelte/store";
import { splitTags } from "../protocol/crypto.js";

// Editing state is scoped to the rendered editor. The media store owns the PUT.
export function createTagEditor(save) {
	const state = writable({
		editing: false,
		value: "",
		saving: false,
		failed: false,
		inputFocus: 0,
		buttonFocus: 0,
	});
	let disposed = false;
	let blurred = false;
	function cancel() {
		if (disposed || get(state).saving) return;
		state.update((value) => ({
			...value,
			editing: false,
			value: "",
			failed: false,
			buttonFocus: value.buttonFocus + 1,
		}));
	}
	async function persist(tags, clearDraft = false) {
		if (disposed || get(state).saving) return false;
		const submitted = get(state).value;
		blurred = false;
		state.update((value) => ({
			...value,
			saving: true,
			inputFocus: value.inputFocus + 1,
		}));
		let success = false;
		try {
			success = Boolean(await save(tags));
		} finally {
			if (!disposed)
				state.update((value) => ({
					...value,
					saving: false,
					failed: !success,
					value:
						success && (blurred || (clearDraft && value.value === submitted))
							? ""
							: value.value,
					editing: success && blurred ? false : value.editing,
					inputFocus: blurred ? value.inputFocus : value.inputFocus + 1,
				}));
		}
		return success;
	}
	return {
		subscribe: state.subscribe,
		edit(value) {
			if (!disposed) state.update((current) => ({ ...current, value }));
		},
		open() {
			if (!disposed)
				state.update((value) => ({
					...value,
					editing: true,
					inputFocus: value.inputFocus + 1,
				}));
		},
		cancel,
		blur() {
			if (disposed) return;
			if (get(state).saving) blurred = true;
			else if (!get(state).failed)
				state.update((value) => ({ ...value, editing: false, value: "" }));
		},
		add(tags) {
			if (splitTags(get(state).value).length)
				return persist([...tags, get(state).value], true);
		},
		remove: (tags) => persist(tags),
		dispose() {
			disposed = true;
		},
	};
}
