import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("./", import.meta.url);
const output = new URL("../dist/extension/", import.meta.url);
const archive = new URL("../dist/i2nclip-extension.zip", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of [
	"manifest.json",
	"background.js",
	"capture.js",
	"bridge.js",
	"options.html",
	"options.js",
	"icon.svg",
]) {
	await copyFile(new URL(file, source), new URL(file, output));
}
await rm(archive, { force: true });
execFileSync("zip", ["-q", "-r", fileURLToPath(archive), "."], { cwd: output });
