import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { emitKeypressEvents } from "node:readline";

export function recoveryPath(env = process.env, home = homedir()) {
	const base = env.XDG_CONFIG_HOME;
	return join(
		base && isAbsolute(base) ? base : join(home, ".config"),
		"i2nclip",
		"recovery.json",
	);
}

export async function readFileBounded(path, limit, signal) {
	const file = await open(path, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Expected a regular file.");
		if (stat.size > limit)
			throw new Error(`File exceeds the ${limit}-byte limit.`);
		const chunks = [];
		let size = 0;
		for await (const chunk of file.createReadStream({
			autoClose: false,
			signal,
		})) {
			size += chunk.length;
			if (size > limit)
				throw new Error(`File exceeds the ${limit}-byte limit.`);
			chunks.push(chunk);
		}
		signal?.throwIfAborted();
		return Buffer.concat(chunks, size);
	} finally {
		await file.close();
	}
}

export async function writeExclusive(path, bytes, signal) {
	signal?.throwIfAborted();
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(bytes, { signal });
	} catch (error) {
		await file.close();
		await unlink(path);
		throw error;
	}
	await file.close();
}

export async function saveRecovery(path, text, useDefault, signal) {
	if (useDefault) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeExclusive(path, text, signal);
}

export async function passwordFromFile(path, signal) {
	let bytes;
	if (path === "/dev/stdin") {
		const chunks = [];
		let size = 0;
		const stream = process.stdin;
		const abort = () => stream.destroy(signal.reason);
		signal?.throwIfAborted();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			for await (const chunk of stream) {
				size += chunk.length;
				if (size > 65536) throw new Error("Password file is too large.");
				chunks.push(chunk);
			}
			bytes = Buffer.concat(chunks, size);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	} else bytes = await readFileBounded(path, 65536, signal);
	return bytes.toString("utf8").replace(/\r?\n$/, "");
}

export function promptPassword(
	label,
	signal,
	input = process.stdin,
	output = process.stderr,
) {
	if (!input.isTTY || !output.isTTY)
		throw new Error("Use --password-file for noninteractive commands.");
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const wasRaw = input.isRaw;
		const wasPaused = input.isPaused();
		const chars = [];
		const finish = (error) => {
			input.removeListener("keypress", keypress);
			signal?.removeEventListener("abort", abort);
			input.setRawMode(Boolean(wasRaw));
			if (wasPaused) input.pause();
			output.write("\n");
			if (error) reject(error);
			else resolve(chars.join(""));
		};
		const abort = () => finish(signal.reason);
		const keypress = (text, key) => {
			if (key?.ctrl && key.name === "c") {
				finish(new DOMException("Interrupted.", "AbortError"));
			} else if (key?.name === "return" || key?.name === "enter") finish();
			else if (key?.name === "backspace") chars.pop();
			else if (key?.ctrl && key.name === "u") chars.length = 0;
			else if (
				text &&
				!key?.ctrl &&
				!key?.meta &&
				![...text].some(
					(char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
				)
			)
				chars.push(...text);
		};
		emitKeypressEvents(input);
		input.on("keypress", keypress);
		signal?.addEventListener("abort", abort, { once: true });
		input.setRawMode(true);
		input.resume();
		output.write(label);
	});
}
