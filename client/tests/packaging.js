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
	assert(names.some((name) => /^assets\/.*\.js$/.test(name)));
	assert(names.some((name) => /^assets\/.*\.css$/.test(name)));
	assert(
		names.every(
			(name) => name === "index.html" || /^assets\/[^/]+\.(js|css)$/.test(name),
		),
	);
	const html = await readFile(join(dist, "web/index.html"), "utf8");
	for (const [, asset] of html.matchAll(/(?:src|href)="\/([^" ]+)"/g)) {
		assert(names.includes(asset), `Missing web asset: ${asset}`);
	}
});

test("XPI contains referenced runtime assets without update metadata", async () => {
	const names = await entries("i2nclip.xpi", "unzip", ["-Z1"]);
	const assets = [
		"manifest.json",
		"library.html",
		"options.html",
		"upload.html",
		"unlock.html",
		"icon.svg",
		"app.js",
		"background.js",
		"app.css",
	];
	for (const name of assets)
		assert(names.includes(name), `Missing extension asset: ${name}`);
	assert(
		names.every(
			(name) => assets.includes(name) || /^chunks\/[^/]+\.js$/.test(name),
		),
	);
	const manifest = JSON.parse(
		await readFile(join(dist, "extension/manifest.json"), "utf8"),
	);
	for (const name of [
		...manifest.background.scripts,
		manifest.options_ui.page,
		...Object.values(manifest.icons),
		manifest.action.default_icon,
	]) {
		assert(names.includes(name), `Missing manifest reference: ${name}`);
	}
	for (const page of assets.filter((name) => name.endsWith(".html"))) {
		const html = await readFile(join(dist, "extension", page), "utf8");
		for (const [, asset] of html.matchAll(/(?:src|href)="([^" ]+)"/g)) {
			assert(
				names.includes(asset.replace(/^\.\//, "")),
				`Missing page reference: ${asset}`,
			);
		}
	}
});

test("CLI archive runs outside the repository without npm dependencies", async () => {
	assert.deepEqual(await entries("i2nclip-cli.tar.gz", "tar", ["-tzf"]), [
		"i2nclip-cli/i2nclip.mjs",
	]);
	const dir = await mkdtemp(join(tmpdir(), "i2nclip-package-"));
	try {
		await execute("tar", ["-xzf", join(dist, "i2nclip-cli.tar.gz"), "-C", dir]);
		const executable = join(dir, "i2nclip-cli/i2nclip.mjs");
		assert.equal((await stat(executable)).mode & 0o777, 0o755);
		assert(
			(await readFile(executable, "utf8")).startsWith("#!/usr/bin/env node\n"),
		);
		const { stdout, stderr } = await execute(executable, ["--help"], {
			cwd: dir,
		});
		assert.match(stdout, /Usage: i2nclip COMMAND/);
		assert.equal(stderr, "");
		await assert.rejects(
			execute(process.execPath, [executable, "unknown"], { cwd: dir }),
			(error) => error.code === 2 && /Choose a command/.test(error.stderr),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
