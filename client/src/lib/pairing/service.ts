import type { LoadedKey } from "../protocol/crypto.ts";
import { authorizationHeader, freshNonce } from "../protocol/crypto.ts";
import { CONTENT_TYPE, decode, encode } from "../protocol/msgpack.ts";
import { pairingContext, pairingOrigin } from "../protocol/pairing.ts";
import {
	bytes as binary,
	document,
	number,
	string,
} from "../protocol/value.ts";
import type {
	CryptoAction,
	CryptoArgs,
	CryptoResults,
	createPairingCrypto,
} from "./crypto.ts";
export interface Room {
	v: number;
	id: string;
	instance: string;
	step: number;
	remaining_secs: number;
	capability?: string;
	message: Uint8Array<ArrayBuffer> | null;
}

const MAX_BODY = 16384;
// Each pairing adapter executes one isolated, disposable PAKE attempt.
export function pairingCrypto() {
	const controller = new AbortController();
	const { signal } = controller;
	let running = false;
	let execute: ReturnType<typeof createPairingCrypto> | null = null;
	return {
		async call<A extends CryptoAction>(
			action: A,
			args: CryptoArgs = {},
		): Promise<CryptoResults[A]> {
			signal.throwIfAborted();
			if (running) {
				throw new Error("Pairing is busy.");
			}
			running = true;
			let onAbort: () => void = () => {};
			const stopped = new Promise<never>((_, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
			const work = async () => {
				const { createPairingCrypto } = await import("./crypto.ts");
				signal.throwIfAborted();
				execute ||= createPairingCrypto();
				const current = execute;
				try {
					return await current(action, args);
				} finally {
					// Crypto already in flight can finish after the caller is canceled.
					if (signal.aborted) {
						current.dispose();
					}
				}
			};
			try {
				const value = await Promise.race([work(), stopped]);
				signal.throwIfAborted();
				return value;
			} catch {
				signal.throwIfAborted();
				throw new Error("Pairing authentication failed. Create a new code.");
			} finally {
				signal.removeEventListener("abort", onAbort);
				running = false;
			}
		},
		dispose() {
			controller.abort(new DOMException("Pairing ended.", "AbortError"));
			execute?.dispose();
			execute = null;
		},
	};
}
export async function readPairingResponse(response: Response) {
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
		return decode(bytes);
	} catch {
		throw new Error("Invalid pairing response.");
	}
}
export function pairingRelay(serverUrl: string, signal: AbortSignal) {
	const origin = pairingOrigin(serverUrl);
	async function request(
		method: "DELETE",
		path: string,
		payload?: unknown,
		capability?: string | null,
		key?: LoadedKey,
	): Promise<null>;
	async function request(
		method: "GET" | "POST",
		path: string,
		payload?: unknown,
		capability?: string | null,
		key?: LoadedKey,
	): Promise<Room>;
	async function request(
		method: string,
		path: string,
		payload?: unknown,
		capability?: string | null,
		key?: LoadedKey,
	): Promise<Room | null> {
		const body = payload === undefined ? undefined : encode(payload);
		if (body && body.length > MAX_BODY) {
			throw new Error("Pairing message is too large.");
		}
		let authorization: string | undefined;
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
		const deadline = AbortSignal.timeout(10000);
		const combined = AbortSignal.any([signal, deadline]);
		combined.throwIfAborted();
		const response = await fetch(new URL(path, origin), {
			method,
			body,
			headers: {
				"content-type": CONTENT_TYPE,
				...(authorization ? { authorization } : {}),
			},
			signal: combined,
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			const errors: Record<number, string> = {
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
		let value: Record<string, unknown>;
		try {
			value = document(await readPairingResponse(response));
		} catch (error) {
			combined.throwIfAborted();
			throw error;
		}
		pairingContext(origin, value);
		if (
			typeof value.step !== "number" ||
			!Number.isInteger(value.step) ||
			value.step < 0 ||
			value.step > 5 ||
			typeof value.remaining_secs !== "number" ||
			!Number.isInteger(value.remaining_secs) ||
			value.remaining_secs < 0 ||
			value.remaining_secs > 120 ||
			(value.step > 0 &&
				(!(value.message instanceof Uint8Array) || value.message.length > 8192))
		) {
			throw new Error("Invalid pairing response.");
		}
		return {
			...value,
			v: number(value.v),
			id: string(value.id),
			instance: string(value.instance),
			step: value.step,
			remaining_secs: value.remaining_secs,
			capability:
				value.capability === undefined ? undefined : string(value.capability),
			message: value.message === null ? null : binary(value.message),
		};
	}
	return {
		origin,
		create: (key: LoadedKey) =>
			request("POST", "/api/pairings", { v: 1 }, null, key),
		join: (id: string, message: Uint8Array<ArrayBuffer>) =>
			request("POST", `/api/pairings/${id}/join`, { message }),
		poll: (room: Room) =>
			request(
				"GET",
				`/api/pairings/${room.id}/messages`,
				undefined,
				room.capability,
			),
		submit: (room: Room, step: number, message: Uint8Array<ArrayBuffer>) =>
			request(
				"POST",
				`/api/pairings/${room.id}/messages`,
				{ step, message },
				room.capability,
			),
		cancel: (room: Room) =>
			request("DELETE", `/api/pairings/${room.id}`, undefined, room.capability),
	};
}
