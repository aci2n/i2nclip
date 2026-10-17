// Narrow external documents before their fields enter typed application code.
export function document(
	value: unknown,
	message = "Invalid document.",
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value instanceof Uint8Array
	) {
		throw new Error(message);
	}
	return value as Record<string, unknown>;
}
export function string(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("Invalid string.");
	}
	return value;
}
export function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("Invalid number.");
	}
	return value;
}
export function bytes(value: unknown): Uint8Array<ArrayBuffer> {
	if (
		!(value instanceof Uint8Array) ||
		!(value.buffer instanceof ArrayBuffer)
	) {
		throw new Error("Invalid bytes.");
	}
	// The buffer check excludes SharedArrayBuffer without copying owned bytes.
	return value as Uint8Array<ArrayBuffer>;
}
