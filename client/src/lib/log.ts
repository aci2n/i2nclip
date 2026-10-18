type Fields = Record<string, string | number | boolean | null | undefined>;

// Never pass raw errors or application objects to the console.
export function failureFields(error: unknown): Fields {
	const name = error instanceof Error ? error.name : "";
	const category = [
		"AbortError",
		"TimeoutError",
		"TypeError",
		"SyntaxError",
		"OperationError",
		"DataError",
		"QuotaExceededError",
		"SecurityError",
	].includes(name)
		? name
		: "Error";
	const status =
		error &&
		typeof error === "object" &&
		"status" in error &&
		typeof error.status === "number"
			? error.status
			: undefined;
	return { category, ...(status === undefined ? {} : { status }) };
}

export function createLog(scope: string) {
	const instance = crypto.randomUUID();
	let sequence = 0;
	function write(
		level: "debug" | "info" | "warn" | "error",
		event: string,
		fields: Fields = {},
	) {
		try {
			console[level](`[i2nclip] ${scope}.${event}`, { ...fields, instance });
		} catch {
			// Diagnostics must not interrupt application work.
		}
	}
	return {
		operation: () => ++sequence,
		debug: (event: string, fields?: Fields) => write("debug", event, fields),
		info: (event: string, fields?: Fields) => write("info", event, fields),
		warn: (event: string, fields?: Fields) => write("warn", event, fields),
		error: (event: string, fields?: Fields) => write("error", event, fields),
	};
}
