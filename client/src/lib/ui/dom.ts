import { tick } from "svelte";

type Selection = boolean | { opener?: HTMLElement | null } | null;

// Browser actions own modal lifecycle and file input handling.
export function modal(node: HTMLDialogElement, selected: Selection) {
	let opener: Element | null = null;
	const update = (selected: Selection) => {
		if (selected && !node.open) {
			opener =
				(typeof selected === "object" ? selected.opener : null) ||
				node.ownerDocument.activeElement;
			node.showModal();
		} else if (!selected && node.open) {
			node.close();
			const target = opener;
			tick().then(() => {
				if (
					node.isConnected &&
					!node.open &&
					target instanceof HTMLElement &&
					target.isConnected
				) {
					target.focus();
				}
			});
		}
	};
	update(selected);
	return {
		update,
		destroy() {
			if (node.open) {
				node.close();
			}
		},
	};
}

export function selectFiles(
	event: Event & { currentTarget: HTMLInputElement },
	upload: (files: File[]) => void,
) {
	const files = [...(event.currentTarget.files || [])];
	event.currentTarget.value = "";
	if (files.length) {
		upload(files);
	}
}

export const pickFiles = (input: HTMLInputElement | undefined) =>
	input?.click();
