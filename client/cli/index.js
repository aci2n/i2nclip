#!/usr/bin/env node
import { run, UsageError } from "./run.js";

const controller = new AbortController();
const interrupt = () =>
	controller.abort(new DOMException("Interrupted.", "AbortError"));
process.once("SIGINT", interrupt);
try {
	await run(process.argv.slice(2), { signal: controller.signal });
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode =
		error instanceof UsageError
			? 2
			: error.name === "AbortError" || controller.signal.aborted
				? 130
				: 1;
} finally {
	process.removeListener("SIGINT", interrupt);
}
