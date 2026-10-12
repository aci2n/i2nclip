// Names are local editable suggestions; saved names are never rewritten.
export function defaultLibraryName(catalog = []) {
	const used = new Set();
	for (const { name } of catalog) {
		const match = /^personal(?:\s+(\d+))?$/i.exec(name.trim());
		if (!match) {
			continue;
		}
		const number = match[1] ? Number(match[1]) : 1;
		if (Number.isSafeInteger(number) && number > 0) {
			used.add(number);
		}
	}
	let number = 1;
	while (used.has(number)) {
		number++;
	}
	return `Personal ${number}`;
}
