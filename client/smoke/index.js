#!/usr/bin/env node
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { parseArgs } from "node:util";
import { smoketest } from "./run.js";

// Give remote TCP handshakes enough time before trying the other address family.
setDefaultAutoSelectFamilyAttemptTimeout(1000);

const controller = new AbortController();
const interrupt = () =>
	controller.abort(new DOMException("Interrupted.", "AbortError"));
process.once("SIGINT", interrupt);
try {
	const { values } = parseArgs({
		options: { server: { type: "string" }, directory: { type: "string" } },
	});
	await smoketest({
		serverUrl: values.server,
		directory: values.directory,
		signal: controller.signal,
	});
} catch (error) {
	// Only the smoke runner's stage/status is printed, never upstream bodies.
	process.stderr.write(
		error.message.startsWith("Smoke test failed at ")
			? `${error.message}\n`
			: "Invalid smoke-test arguments.\n",
	);
	process.exitCode =
		error.name === "AbortError" || controller.signal.aborted ? 130 : 1;
} finally {
	process.removeListener("SIGINT", interrupt);
}
