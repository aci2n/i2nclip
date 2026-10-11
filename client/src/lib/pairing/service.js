import { utf8 } from "../protocol/bytes.js";
import {
	authorizationHeader,
	freshNonce,
	loadKey,
} from "../protocol/crypto.js";
import { pairingContext, pairingOrigin } from "../protocol/pairing.js";

const MAX_BODY = 16_384;

export function pairingWorker() {
	const worker = new Worker(new URL("./worker.js", import.meta.url), {
		type: "module",
	});
	let sequence = 0;
	const pending = new Map();
	let disposed = false;
	worker.onmessage = ({ data }) => {
		const job = pending.get(data.id);
		if (!job) return;
		pending.delete(data.id);
		if (data.error) job.reject(new Error(data.error));
		else job.resolve(data.value);
	};
	const stop = () => {
		if (disposed) return;
		disposed = true;
		worker.terminate();
		for (const job of pending.values())
			job.reject(new DOMException("Pairing ended.", "AbortError"));
		pending.clear();
	};
	worker.onerror = stop;
	return {
		call(action, args = {}) {
			if (disposed) return Promise.reject(new Error("Pairing is unavailable."));
			return new Promise((resolve, reject) => {
				const id = ++sequence;
				pending.set(id, { resolve, reject });
				worker.postMessage({ id, action, args });
			});
		},
		dispose: stop,
	};
}

export async function readPairingResponse(response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Invalid pairing response.");
	let size = 0;
	const chunks = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY) throw new Error("Pairing response is too large.");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Invalid pairing response.");
	}
}

export function pairingRelay(serverUrl, signal) {
	const origin = pairingOrigin(serverUrl);
	async function request(method, path, payload, capability, privateKey) {
		const body =
			payload === undefined ? undefined : utf8(JSON.stringify(payload));
		if (body?.length > MAX_BODY)
			throw new Error("Pairing message is too large.");
		let authorization;
		if (privateKey)
			authorization = await authorizationHeader({
				key: await loadKey(privateKey),
				origin,
				ts: Math.floor(Date.now() / 1000),
				nonce: freshNonce(),
				method,
				path,
				body,
			});
		else if (capability) authorization = `Bearer ${capability}`;
		const deadline = AbortSignal.timeout(10_000);
		const combined = AbortSignal.any([signal, deadline]);
		combined.throwIfAborted();
		const response = await fetch(new URL(path, origin), {
			method,
			body,
			headers: {
				"content-type": "application/json",
				...(authorization ? { authorization } : {}),
			},
			signal: combined,
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			const errors = {
				401: "Pairing authorization failed.",
				404: "Pairing ended, expired, or is unsupported by this server.",
				409: "Pairing is already in use. Create a new code.",
				429: "Too many pairing requests. Wait a minute and try again.",
				503: "Pairing is temporarily unavailable. Try again.",
			};
			throw new Error(errors[response.status] || "Pairing request failed.");
		}
		if (response.status === 204) return null;
		let value;
		try {
			value = await readPairingResponse(response);
		} catch (error) {
			combined.throwIfAborted();
			throw error;
		}
		pairingContext(origin, value);
		if (
			!Number.isInteger(value.step) ||
			value.step < 0 ||
			value.step > 5 ||
			!Number.isInteger(value.remaining_secs) ||
			value.remaining_secs < 0 ||
			value.remaining_secs > 120 ||
			(value.step > 0 &&
				(typeof value.message !== "string" || value.message.length > 8192))
		)
			throw new Error("Invalid pairing response.");
		return value;
	}
	return {
		origin,
		create: (privateKey) =>
			request("POST", "/api/pairings", { v: 1 }, null, privateKey),
		join: (id, message) =>
			request("POST", `/api/pairings/${id}/join`, { message }),
		poll: (room) =>
			request(
				"GET",
				`/api/pairings/${room.id}/messages`,
				undefined,
				room.capability,
			),
		submit: (room, step, message) =>
			request(
				"POST",
				`/api/pairings/${room.id}/messages`,
				{ step, message },
				room.capability,
			),
		cancel: (room) =>
			request("DELETE", `/api/pairings/${room.id}`, undefined, room.capability),
	};
}
