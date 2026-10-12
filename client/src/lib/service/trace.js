// The build plugin replaces this module for release owners, including workers.
export const serviceTracing =
	import.meta.env?.DEV || import.meta.env?.MODE === "debug";

const secrets =
	/^(password|passphrase|privateKey|wrappedKey|code|otc|invitation|secret)$/i;

export function summarizeMessage(value, depth = 0) {
	if (value instanceof Blob)
		return { binary: "Blob", size: value.size, type: value.type };
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
		return { binary: value.constructor.name, byteLength: value.byteLength };
	if (!value || typeof value !== "object") return value;
	if (depth >= 6) return "[nested object]";
	if (Array.isArray(value)) {
		const items = value
			.slice(0, 20)
			.map((item) => summarizeMessage(item, depth + 1));
		if (value.length > 20) items.push(`[${value.length - 20} more items]`);
		return items;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			secrets.test(key) ? "[redacted]" : summarizeMessage(item, depth + 1),
		]),
	);
}

export function traceMessage(direction, clientId, message) {
	console.debug(
		`[i2nclip service] ${direction} ${clientId} ${message.type}${message.name || message.topic ? ` ${message.name || message.topic}` : ""}`,
		summarizeMessage(message),
	);
}
