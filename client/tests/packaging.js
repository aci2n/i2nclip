import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const dist = fileURLToPath(new URL("../dist/", import.meta.url));

async function entries(file, command, args) {
	const { stdout } = await execute(command, [...args, join(dist, file)]);
	return stdout
		.trim()
		.split("\n")
		.filter((name) => !name.endsWith("/"));
}

test("web ZIP contains only its entry page and bundled assets", async () => {
	const names = await entries("i2nclip-web.zip", "unzip", ["-Z1"]);
	assert(names.includes("index.html"));
	assert(names.includes("favicon.ico"));
	assert(names.includes("assets/web-worker.js"));
	assert(!names.includes("assets/worker.js"));
	assert(names.some((name) => /^assets\/crypto-.*\.js$/.test(name)));
	assert(names.some((name) => /^assets\/.*\.js$/.test(name)));
	assert(names.some((name) => /^assets\/.*\.css$/.test(name)));
	assert(
		names.every(
			(name) =>
				name === "index.html" ||
				name === "favicon.ico" ||
				/^assets\/[^/]+\.(js|css)$/.test(name),
		),
	);
	const html = await readFile(join(dist, "web/index.html"), "utf8");
	for (const [, asset] of html.matchAll(/(?:src|href)="\/([^" ]+)"/g)) {
		assert(names.includes(asset), `Missing web asset: ${asset}`);
	}
});

