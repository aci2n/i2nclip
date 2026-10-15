import { tick } from "svelte";

// Browser actions own modal lifecycle and file input handling.
export function modal(node, selected) {
	let opener;
	const update = (selected) => {
		if (selected && !node.open) {
			opener = selected.opener || node.ownerDocument.activeElement;
			node.showModal();
		} else if (!selected && node.open) {
			node.close();
			const target = opener;
			tick().then(() => {
				if (node.isConnected && !node.open && target?.isConnected) {
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

export function selectFiles(event, upload) {
	const files = [...event.currentTarget.files];
	event.currentTarget.value = "";
	if (files.length) {
		upload(files);
	}
}

export const pickFiles = (input) => input.click();
