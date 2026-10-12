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
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { wrapPrivateKey } from "../src/lib/protocol/vault.js";
import { recoveryFile } from "../src/lib/protocol/recovery.js";

const client = fileURLToPath(new URL("../", import.meta.url));

test("installed Firefox add-on runs OPAQUE and shares a background owner through binary ports across restart", {
	timeout: 60_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "i2nclip-pairing-addon-"));
	let child;
	let logs = "";
	let resolveReport;
	const report = new Promise((resolve) => {
		resolveReport = resolve;
	});
	let uploads = 0;
	const server = createServer((request, response) => {
		if (request.url === "/api/media") {
			request.resume();
			request.on("end", () => {
				if (++uploads > 1) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ id: "a".repeat(64) }));
				}
			});
			return;
		}
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
		manifest.background.scripts.push("pairing-smoke.js");
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
  const verification = await sender("verificationCode");
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(verification)) throw new Error("Invalid verification code");
  if (await receiver("verificationCode") !== verification) throw new Error("Verification codes differ");
  const packet = await sender("transfer", {value: {v: 1, test: "packaged-worker"}});
  const value = await receiver("receive", {message: packet});
  if (value.test !== "packaged-worker") throw new Error("Incorrect transfer");
  const ack = await receiver("acknowledge");
  await sender("verifyAcknowledgment", {message: ack});
  await browser.tabs.create({url: browser.runtime.getURL("service-smoke.html")});
} catch (error) {
  await fetch(${JSON.stringify(endpoint)}, {method: "POST", body: JSON.stringify({error: error.message})});
} finally { for (const worker of workers) worker.terminate(); }
`,
		);
		const key = await generatePrivateKey();
		const recovery = recoveryFile({
			serverUrl: new URL(endpoint).origin,
			wrappedKey: await wrapPrivateKey(key.privateKey, "service-password", 1),
		});
		await writeFile(
			join(addon, "service-smoke.html"),
			'<!doctype html><script type="module" src="service-smoke.js"></script>',
		);
		await writeFile(
			join(addon, "service-smoke.js"),
			`
function connect() {
 const port = browser.runtime.connect({name: "i2nclip-service"});
 let state;
 const pending = new Map();
 let resolveReady; const ready = new Promise(resolve => { resolveReady = resolve; });
 port.onMessage.addListener(message => {
  if (message.type === "snapshot") { state = {...message, value: message.value.libraries[message.value.catalog[0].id], libraryId: message.value.catalog[0].id}; resolveReady(); }
  if (message.type === "state") {
   if (message.topic === "library" && message.value.id === state.libraryId) state.value = message.value.state;
   if (message.topic === "uploads") state.value.uploads = message.value;
  }
  if (message.type === "reply") { const job = pending.get(message.requestId); if (!job) return; pending.delete(message.requestId); if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.value); }
 });
 return {ready, get state() {return state.value;}, command(name, payload = {}) { const requestId = crypto.randomUUID(); return new Promise((resolve, reject) => { pending.set(requestId, {resolve, reject}); port.postMessage({type: "command", instanceId: state.instanceId, requestId, name, payload: {...payload, epoch: state.value.session.epoch, libraryId: state.libraryId}}); }); }, close: () => port.disconnect()};
}
async function until(check) { const end = Date.now() + 15000; while (!check()) { if (Date.now() > end) throw new Error("Service state did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); } }
try {
 const first = connect(), second = connect(); await Promise.all([first.ready, second.ready]);
 if (!first.state.session.configured) {
  await first.command("identity.restore", {file: new Blob([${JSON.stringify(recovery)}], {type: "application/json"}), password: "service-password"});
  await until(() => second.state.session.unlocked);
  const backup = await second.command("identity.backup");
  if (!(backup instanceof Blob) || !(await backup.text()).includes("i2nclip-recovery")) throw new Error("Binary reply did not cross runtime.Port");
  if (JSON.stringify(second.state).includes("privateKey")) throw new Error("Private key leaked to client");
  const sources = [{blob: new Blob([new Uint8Array(65536)]), name: "retained.bin", preview: null}, {blob: new Blob(["queued"]), name: "queued.txt", preview: null}];
  await first.command("uploads.submit", {sources});
  await until(() => first.state.uploads.some(job => job.status === "uploading"));
  await new Promise(resolve => setTimeout(resolve, 500));
  browser.runtime.reload();
 } else {
  if (first.state.session.unlocked) throw new Error("Restart restored plaintext key");
  if (!first.state.uploads.some(job => job.status === "interrupted") || !first.state.uploads.some(job => job.status === "paused")) throw new Error("Restart lost unfinished jobs");
  await first.command("identity.unlock", {password: "service-password"});
  await second.command("uploads.retry", {ids: first.state.uploads.map(job => job.id)});
  await until(() => second.state.uploads.every(job => job.status === "completed"));
  await first.command("identity.reset"); await until(() => !second.state.session.configured);
  await fetch(${JSON.stringify(endpoint)}, {method: "POST", body: JSON.stringify({ok: true})});
  first.close(); second.close();
 }
} catch (error) { await fetch(${JSON.stringify(endpoint)}, {method: "POST", body: JSON.stringify({error: error.message})}); }
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
