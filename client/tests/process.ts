import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { document, string } from "../src/lib/protocol/value.ts";
// Shared process ownership for real browser tests and the optional resource profile.

export const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const execute = promisify(execFile);
const metadata = await execute(
	"cargo",
	["metadata", "--format-version", "1", "--no-deps"],
	{ cwd: root },
);
const target = string(document(JSON.parse(metadata.stdout)).target_directory);
const binary = (name: string, profile = "debug", example = false) =>
	path.join(
		target,
		profile,
		...(example ? ["examples"] : []),
		`${name}${process.platform === "win32" ? ".exe" : ""}`,
	);

function fixtureEnvironment(data?: string) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		I2N_DATABASE_URL: data,
		I2N_WEB_DIR: path.join(root, "client/dist/web"),
	};
	delete env.I2N_DATABASE_URL_FILE;
	return env;
}
export async function database(
	operation: "create" | "drop" | "inspect",
	data?: string,
) {
	const { stdout } = await execute(
		binary("test-database", "debug", true),
		[operation],
		{ env: fixtureEnvironment(data) },
	);
	return stdout.trim();
}
export async function issueOtc(
	data: string,
	profile = "debug",
	maxBytes?: number,
) {
	const { stdout } = await execute(
		binary("i2nclip", profile),
		[
			"otc",
			"issue",
			...(maxBytes === undefined ? [] : ["--max-bytes", String(maxBytes)]),
		],
		{ env: fixtureEnvironment(data) },
	);
	return stdout.trim();
}
export async function setKeyLimits(
	data: string,
	publicKey: string,
	limits: { maxBytes: number; maxFiles: number },
) {
	await execute(
		binary("i2nclip"),
		[
			"key",
			"set-limits",
			publicKey,
			"--max-bytes",
			String(limits.maxBytes),
			"--max-files",
			String(limits.maxFiles),
		],
		{ env: fixtureEnvironment(data) },
	);
}
export async function stopServer(child?: ChildProcess) {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill("SIGTERM");
	});
}
export async function startServer(
	data: string,
	profile = "debug",
	webDirectory = path.join(root, "client/dist/web"),
) {
	const child = spawn(binary("test-server", profile, true), [], {
		env: { ...fixtureEnvironment(data), I2N_WEB_DIR: webDirectory },
		stdio: ["ignore", "pipe", "inherit"],
	});
	try {
		const origin = await new Promise<string>((resolve, reject) => {
			let output = "";
			const timer = setTimeout(
				() => reject(new Error("Test server did not start within 30 seconds.")),
				30_000,
			);
			child.stdout.on("data", (chunk) => {
				output += chunk;
				const match = output.match(/^ready (http:\/\/127\.0\.0\.1:\d+)\n/m);
				if (match) {
					clearTimeout(timer);
					resolve(match[1]);
				}
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`Test server exited during startup (${code}).`));
			});
		});
		return { child, origin };
	} catch (error) {
		await stopServer(child);
		throw error;
	}
}
