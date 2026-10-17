export function assertPresent<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("Required test value is missing.");
	}
	return value;
}
