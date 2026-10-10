// Small DOM adapters. Components declare the desired focus/modal state;
// these actions own the imperative browser calls and their cleanup.
export function focus(node, request) {
	let disposed = false;
	const update = (request) => {
		if (request)
			queueMicrotask(() => {
				if (!disposed && node.isConnected) node.focus();
			});
	};
	update(request);
	return {
		update,
		destroy() {
			disposed = true;
		},
	};
}

export function modal(node, selected) {
	let opener;
	const update = (selected) => {
		if (selected && !node.open) {
			opener = selected.opener || node.ownerDocument.activeElement;
			node.showModal();
		} else if (!selected && node.open) {
			node.close();
			if (opener?.isConnected) opener.focus();
		}
	};
	update(selected);
	return {
		update,
		destroy() {
			if (node.open) node.close();
		},
	};
}

export function selectTab(event, current, select) {
	if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
	event.preventDefault();
	const next =
		event.key === "Home"
			? "create"
			: event.key === "End"
				? "restore"
				: current === "create"
					? "restore"
					: "create";
	select(next);
	event.currentTarget.querySelector(`#${next}-tab`).focus();
}

export function validateInput(input, details) {
	if (input.checkValidity()) return true;
	details.open = true;
	input.reportValidity();
	return false;
}

export function selectFiles(event, upload) {
	const files = [...event.currentTarget.files];
	event.currentTarget.value = "";
	if (files.length) upload(files);
}

export const pickFiles = (input) => input.click();
