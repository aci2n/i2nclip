import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("./", import.meta.url);
const output = new URL("../dist/extension/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
execFileSync(
	process.execPath,
	[
		fileURLToPath(
			new URL("../node_modules/typescript/bin/tsc", import.meta.url),
		),
		"-p",
		fileURLToPath(new URL("../tsconfig.extension.json", import.meta.url)),
	],
	{ stdio: "inherit" },
);
for (const file of ["manifest.json", "options.html", "icon.svg"]) {
	await copyFile(new URL(file, source), new URL(file, output));
}
