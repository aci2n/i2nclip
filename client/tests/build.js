import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

async function entries(directory) {
	const names = await readdir(join(dist, directory), {
		recursive: true,
		withFileTypes: true,
	});
	return names
		.filter((entry) => entry.isFile())
		.map((entry) =>
			join(entry.parentPath, entry.name).slice(
				join(dist, directory).length + 1,
			),
		);
}

test("web build contains only its entry page and bundled assets", async () => {
	const names = await entries("web");
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

test("extension build contains only the bridge and its configuration page", async () => {
	const names = await entries("extension");
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
