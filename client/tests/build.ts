import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { document } from "../src/lib/protocol/value.ts";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

async function entries(directory: string) {
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
	assert(names.includes("streaming-worker.js"));
	assert(names.includes("streaming-worker.js.map"));
	const worker = await readFile(join(dist, "web/streaming-worker.js"), "utf8");
	assert(worker.includes("//# sourceMappingURL=streaming-worker.js.map"));
	const workerMap = document(
		JSON.parse(
			await readFile(join(dist, "web/streaming-worker.js.map"), "utf8"),
		),
	);
	assert.equal(workerMap.version, 3);
	assert(Array.isArray(workerMap.sources) && workerMap.sources.length > 0);
	assert(!names.some((name) => /background|manifest/.test(name)));
	assert(names.some((name) => /^assets\/.*\.js$/.test(name)));
	assert(names.some((name) => /^assets\/.*\.css$/.test(name)));
	assert(
		names.every(
			(name) =>
				name === "index.html" ||
				name === "favicon.ico" ||
				name === "streaming-worker.js" ||
				name === "streaming-worker.js.map" ||
				/^assets\/[^/]+\.(js|css)(\.map)?$/.test(name),
		),
	);
	for (const name of names.filter((name) => name.endsWith(".map"))) {
		assert(
			names.includes(name.slice(0, -4)),
			`Source map has no generated asset: ${name}`,
		);
	}
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
	const manifest = document(
		JSON.parse(await readFile(join(dist, "extension/manifest.json"), "utf8")),
	);
	assert.equal(manifest.manifest_version, 3);
	assert.equal(document(manifest.options_ui).open_in_tab, false);
	assert.deepEqual(document(manifest.background).scripts, ["background.js"]);
	assert(!manifest.content_scripts);
	assert(!manifest.externally_connectable);
	assert(Array.isArray(manifest.permissions));
	assert(!manifest.permissions.includes("downloads"));
});

test("emitted extension modules resolve JavaScript imports and keep injected functions self-contained", async () => {
	for (const name of ["background", "capture", "options"]) {
		const script = await readFile(join(dist, `extension/${name}.js`), "utf8");
		for (const match of script.matchAll(/from "\.\/([^" ]+)"/g)) {
			assert(match[1].endsWith(".js"));
			await readFile(join(dist, "extension", match[1]));
		}
	}
	const bridge: unknown = await import(
		pathToFileURL(join(dist, "extension/bridge.js")).href
	);
	const install = document(bridge).installBridge;
	assert.equal(typeof install, "function");
	if (typeof install !== "function") {
		assert.fail("Missing bridge entrypoint");
	}
	let listeners = 0;
	runInNewContext(`(${install.toString()})()`, {
		crypto,
		browser: {
			runtime: {
				onMessage: {
					addListener() {
						listeners++;
					},
				},
			},
		},
	});
	assert.equal(listeners, 1);
	const capture: unknown = await import(
		pathToFileURL(join(dist, "extension/capture.js")).href
	);
	const details = document(capture).captureDetails;
	if (typeof details !== "function") {
		assert.fail("Missing capture entrypoint");
	}
	const result = runInNewContext(`(${details.toString()})(null)`, {
		document: { title: "Source page" },
		location: { href: "https://example.com/photo" },
	});
	assert.equal(result.title, "Source page");
	assert.equal(result.url, "https://example.com/photo");
});
