// Explicit browser verification: node --test tests/extension-pairing.js.
// Installs a temporary copy of the built add-on and exercises its actual Worker
// under the manifest CSP. It never uses an existing Firefox profile or identity.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	cp,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const client = fileURLToPath(new URL("../", import.meta.url));

test("installed Firefox add-on runs the packaged OPAQUE workers under its manifest CSP", {
	timeout: 60_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "i2nclip-pairing-addon-"));
	let child;
	let logs = "";
	let resolveReport;
	const report = new Promise((resolve) => {
		resolveReport = resolve;
	});
	const server = createServer((request, response) => {
		let text = "";
		request.on("data", (chunk) => {
			text += chunk;
			if (text.length > 4096) request.destroy();
		});
		request.on("end", () => {
			try {
				resolveReport(JSON.parse(text));
			} catch {
				resolveReport({ error: "Invalid add-on report" });
			}
			response.writeHead(204);
			response.end();
		});
	});
	let timer;
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const endpoint = `http://127.0.0.1:${server.address().port}/report`;
		const addon = join(directory, "addon");
		await cp(join(client, "dist/extension"), addon, { recursive: true });
		const manifest = JSON.parse(
			await readFile(join(addon, "manifest.json"), "utf8"),
		);
		assert.equal(
			manifest.content_security_policy.extension_pages,
			"script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'",
		);
		manifest.background = { scripts: ["pairing-smoke.js"], type: "module" };
		await writeFile(join(addon, "manifest.json"), JSON.stringify(manifest));
		const worker = (await readdir(join(addon, "chunks"))).find((name) =>
			/^worker-.*\.js$/.test(name),
		);
		assert(worker, "Packaged worker missing");
		await writeFile(
			join(addon, "pairing-smoke.js"),
			`
const workers = [];
function endpoint() {
  const worker = new Worker(browser.runtime.getURL(${JSON.stringify(`chunks/${worker}`)}), {type: "module"});
  workers.push(worker);
  let sequence = 0;
  const pending = new Map();
  worker.onmessage = ({data}) => {
    const job = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error)); else job.resolve(data.value);
  };
  worker.onerror = () => { for (const job of pending.values()) job.reject(new Error("Packaged worker failed")); };
  return (action, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, {resolve, reject});
    worker.postMessage({id, action, args});
  });
}
try {
  const sender = endpoint(), receiver = endpoint();
  const context = "i2nclip/pairing/v1 https://clip.example K7MP abcdefghijklmnopqrstuv";
  await sender("senderSetup", {secret: "W4TXN9RC", context});
  const initial = await receiver("receiverStart", {secret: "W4TXN9RC"});
  const response = await sender("senderResponse", {message: initial});
  const finish = await receiver("receiverFinish", {message: response, context});
  await sender("senderFinish", {message: finish});
  const packet = await sender("transfer", {value: {v: 1, test: "packaged-worker"}});
  const value = await receiver("receive", {message: packet});
  if (value.test !== "packaged-worker") throw new Error("Incorrect transfer");
  const ack = await receiver("acknowledge");
  await sender("verifyAcknowledgment", {message: ack});
  await fetch(${JSON.stringify(endpoint)}, {method: "POST", body: JSON.stringify({ok: true})});
} catch (error) {
  await fetch(${JSON.stringify(endpoint)}, {method: "POST", body: JSON.stringify({error: error.message})});
} finally { for (const worker of workers) worker.terminate(); }
`,
		);
		child = spawn(
			process.execPath,
			[
				join(client, "node_modules/web-ext/bin/web-ext.js"),
				"run",
				"--source-dir",
				addon,
				"--firefox",
				process.env.I2N_TEST_FIREFOX || "/usr/bin/firefox",
				"--no-reload",
				"--no-input",
				"--no-config-discovery",
				"--args=-headless",
				"--pref=security.sandbox.content.level=0",
			],
			{
				detached: true,
				env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		for (const stream of [child.stdout, child.stderr])
			stream.on("data", (chunk) => {
				logs = `${logs}${chunk}`.slice(-8192);
			});
		child.on("error", (error) => resolveReport({ error: error.message }));
		child.on("exit", (code) =>
			resolveReport({ error: `web-ext exited: ${code}` }),
		);
		const result = await Promise.race([
			report,
			new Promise((resolve) => {
				timer = setTimeout(
					() => resolve({ error: "Add-on did not report within 45 seconds" }),
					45_000,
				);
			}),
		]);
		assert.deepEqual(
			result,
			{ ok: true },
			`${JSON.stringify(result)}\n${logs}`,
		);
	} finally {
		clearTimeout(timer);
		if (child?.pid && child.exitCode === null) {
			const exited = once(child, "exit");
			process.kill(-child.pid, "SIGTERM");
			await exited;
		}
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	}
});
