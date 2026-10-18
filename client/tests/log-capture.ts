import type test from "node:test";

export function captureLogs(t: test.TestContext) {
	const events: {
		level: string;
		event: string;
		fields: Record<string, unknown>;
	}[] = [];

	for (const level of ["debug", "info", "warn", "error"] as const) {
		t.mock.method(
			console,
			level,
			(event: string, fields: Record<string, unknown>) => {
				events.push({ level, event, fields });
			},
		);
	}
	return events;
}
