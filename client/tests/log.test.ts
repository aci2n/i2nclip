import assert from "node:assert/strict";
import test from "node:test";
import { createLog, failureFields } from "../src/lib/log.ts";
import { captureLogs } from "./log-capture.ts";

test("console events preserve levels and correlate owners and operations", (t) => {
	const events = captureLogs(t);
	const first = createLog("test");
	const second = createLog("test");
	const operation = first.operation();
	first.info("started", { operation });
	first.debug("step", { operation, step: 2 });
	first.warn("retry", { operation });
	first.error("failed", { operation });
	second.info("started", { operation: second.operation() });
	assert.deepEqual(
		events.map((value) => value.level),
		["info", "debug", "warn", "error", "info"],
	);
	assert.deepEqual(
		events.slice(0, 4).map((value) => value.event),
		[
			"[i2nclip] test.started",
			"[i2nclip] test.step",
			"[i2nclip] test.retry",
			"[i2nclip] test.failed",
		],
	);
	assert(
		events
			.slice(0, 4)
			.every(
				(value) =>
					value.fields.instance === events[0].fields.instance &&
					value.fields.operation === operation,
			),
	);
	assert.notEqual(events[0].fields.instance, events[4].fields.instance);
	assert.equal(first.operation(), 2);
});

test("failure fields exclude arbitrary messages, names, stacks, and attached secrets", () => {
	const error = Object.assign(
		new Error("password secret https://private.example"),
		{
			name: "private filename.jpg",
			status: 403,
			token: "secret token",
			key: "private key",
		},
	);
	assert.deepEqual(failureFields(error), { category: "Error", status: 403 });
	assert.deepEqual(failureFields(new DOMException("secret", "AbortError")), {
		category: "AbortError",
	});
	assert.deepEqual(failureFields("secret"), { category: "Error" });
	assert.deepEqual(failureFields({ status: "secret" }), { category: "Error" });
});

test("a failing console cannot interrupt a workflow", (t) => {
	t.mock.method(console, "info", () => {
		throw new Error("console unavailable");
	});
	assert.doesNotThrow(() => createLog("test").info("completed"));
});
