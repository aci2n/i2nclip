import { utf8 } from "../protocol/bytes.js";
import { authorizationHeader, freshNonce } from "../protocol/crypto.js";
import { pairingContext, pairingOrigin } from "../protocol/pairing.js";

const MAX_BODY = 16_384;

// Each pairing adapter executes one isolated, disposable PAKE attempt.
export function pairingCrypto() {
	let disposed = false;
	let running = false;
	let execute;
	let pending;
	const ended = () => new DOMException("Pairing ended.", "AbortError");
	return {
		call(action, args = {}) {
			if (disposed) {
				return Promise.reject(ended());
			}
			if (running) {
				return Promise.reject(new Error("Pairing is busy."));
			}
			running = true;
			return new Promise((resolve, reject) => {
				const job = { reject };
				pending = job;
				let currentExecute;
				(async () => {
					const { createPairingCrypto } = await import("./crypto.js");
					if (disposed) {
						throw ended();
					}
					execute ||= createPairingCrypto();
					currentExecute = execute;
					return currentExecute(action, args);
				})()
					.then(
						(value) => {
							if (pending === job) {
								pending = null;
								running = false;
							}
							if (disposed) {
								reject(ended());
							} else {
								resolve(value);
							}
						},
						() => {
							if (pending === job) {
								pending = null;
								running = false;
							}
							reject(
								disposed
									? ended()
									: new Error(
											"Pairing authentication failed. Create a new code.",
										),
							);
						},
					)
					.finally(() => {
						if (disposed) {
							currentExecute?.dispose();
						}
					});
			});
		},
		dispose() {
			disposed = true;
			execute?.dispose();
			execute = null;
			pending?.reject(ended());
			pending = null;
		},
	};
}

export async function readPairingResponse(response) {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("Invalid pairing response.");
	}
	let size = 0;
	const chunks = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > MAX_BODY) {
				throw new Error("Pairing response is too large.");
			}
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
	async function request(method, path, payload, capability, key) {
		const body =
			payload === undefined ? undefined : utf8(JSON.stringify(payload));
		if (body?.length > MAX_BODY) {
			throw new Error("Pairing message is too large.");
		}
		let authorization;
		if (key) {
			authorization = await authorizationHeader({
				key,
				origin,
				ts: Math.floor(Date.now() / 1000),
				nonce: freshNonce(),
				method,
				path,
				body,
			});
		} else if (capability) {
			authorization = `Bearer ${capability}`;
		}
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
		if (response.status === 204) {
			return null;
		}
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
		) {
			throw new Error("Invalid pairing response.");
		}
		return value;
	}
	return {
		origin,
		create: (key) => request("POST", "/api/pairings", { v: 1 }, null, key),
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
