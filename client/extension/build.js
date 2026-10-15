import { copyFile, mkdir, rm } from "node:fs/promises";

const source = new URL("./", import.meta.url);
const output = new URL("../dist/extension/", import.meta.url);
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
