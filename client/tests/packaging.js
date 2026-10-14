import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
	assert(!names.some((name) => /worker|background|manifest/.test(name)));
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

test("extension ZIP contains only the bridge and its configuration page", async () => {
	const names = await entries("i2nclip-extension.zip", "unzip", ["-Z1"]);
	assert.deepEqual(names.sort(), [
		"background.js",
		"bridge.js",
		"capture.js",
		"icon.svg",
		"manifest.json",
		"options.html",
		"options.js",
	]);
	const manifest = JSON.parse(
		await readFile(join(dist, "extension/manifest.json"), "utf8"),
	);
	assert.equal(manifest.manifest_version, 3);
	assert.equal(manifest.options_ui.open_in_tab, false);
	assert.deepEqual(manifest.background.scripts, ["background.js"]);
	assert(!manifest.content_scripts);
	assert(!manifest.externally_connectable);
	assert(!manifest.permissions.includes("downloads"));
});
