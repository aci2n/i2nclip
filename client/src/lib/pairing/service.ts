import { sameBytes } from "../protocol/chain.ts";
import type { SigningKey } from "../protocol/crypto.ts";
import { authorizationHeader, freshNonce } from "../protocol/crypto.ts";
import { CONTENT_TYPE, decode, encode } from "../protocol/msgpack.ts";
import { pairingContext, pairingOrigin } from "../protocol/pairing.ts";
import { bytes as binary, number, string } from "../protocol/value.ts";
import { createPairingCrypto, type PairingCrypto } from "./crypto.ts";
export interface Room {
	v: number;
	id: string;
	instance: string;
	step: number;
	remaining_secs: number;
	capability?: string;
	message: Uint8Array<ArrayBuffer> | null;
}

export interface JoinedRoom extends Room {
	capability: string;
}
export interface PairingRelay {
	create(key: SigningKey): Promise<JoinedRoom>;
	join(id: string, message: Uint8Array<ArrayBuffer>): Promise<JoinedRoom>;
	poll(room: JoinedRoom): Promise<Room>;
	submit(
		room: JoinedRoom,
		step: number,
		message: Uint8Array<ArrayBuffer>,
	): Promise<Room>;
	cancel(room: JoinedRoom): Promise<void>;
}
function joinedRoom(room: Room): JoinedRoom {
	if (
		typeof room.capability !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(room.capability)
	) {
		throw new Error("Invalid pairing response.");
	}
	return { ...room, capability: room.capability };
}

const MAX_BODY = 1024 * 1024 + 128;
// Each pairing adapter executes one isolated, disposable PAKE attempt.
export function pairingCrypto(): PairingCrypto {
	return new PairingCryptoService();
}
class PairingCryptoService implements PairingCrypto {
	private readonly controller = new AbortController();
	private running = false;
	private execute: PairingCrypto | null = null;
	readonly senderSetup = (args: Parameters<PairingCrypto["senderSetup"]>[0]) =>
		this.call((crypto) => crypto.senderSetup(args));
	readonly receiverStart = (
		args: Parameters<PairingCrypto["receiverStart"]>[0],
	) => this.call((crypto) => crypto.receiverStart(args));
	readonly senderResponse = (
		args: Parameters<PairingCrypto["senderResponse"]>[0],
	) => this.call((crypto) => crypto.senderResponse(args));
	readonly receiverFinish = (
		args: Parameters<PairingCrypto["receiverFinish"]>[0],
	) => this.call((crypto) => crypto.receiverFinish(args));
	readonly senderFinish = (
		args: Parameters<PairingCrypto["senderFinish"]>[0],
	) => this.call((crypto) => crypto.senderFinish(args));
	readonly verificationCode = () =>
		this.call((crypto) => crypto.verificationCode());
	readonly transfer = (args: Parameters<PairingCrypto["transfer"]>[0]) =>
		this.call((crypto) => crypto.transfer(args));
	readonly receive = (args: Parameters<PairingCrypto["receive"]>[0]) =>
		this.call((crypto) => crypto.receive(args));
	readonly acknowledge = () => this.call((crypto) => crypto.acknowledge());
	readonly verifyAcknowledgment = (
		args: Parameters<PairingCrypto["verifyAcknowledgment"]>[0],
	) => this.call((crypto) => crypto.verifyAcknowledgment(args));
	readonly dispose = this.disposeCrypto.bind(this);
	private async call<T>(
		operation: (executor: PairingCrypto) => Promise<T>,
	): Promise<T> {
		const { signal } = this.controller;
		signal.throwIfAborted();
		if (this.running) {
			throw new Error("Pairing is busy.");
		}
		this.running = true;
		let onAbort: () => void = () => {};
		const stopped = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		const work = async () => {
			signal.throwIfAborted();
			this.execute ??= createPairingCrypto();
			const current = this.execute;
			try {
				return await operation(current);
			} finally {
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
			this.running = false;
		}
	}
	private disposeCrypto() {
		this.controller.abort(new DOMException("Pairing ended.", "AbortError"));
		this.execute?.dispose();
		this.execute = null;
	}
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
		const value = decode(bytes);
		if (!sameBytes(bytes, encode(value))) {
			throw new Error("Noncanonical pairing response.");
		}
		return value;
	} catch {
		throw new Error("Invalid pairing response.");
	}
}
export function pairingRelay(
	serverUrl: string,
	signal: AbortSignal,
): PairingRelay {
	return new PairingRelayImpl(serverUrl, signal);
}
class PairingRelayImpl implements PairingRelay {
	private readonly origin: string;
	private readonly signal: AbortSignal;
	readonly create = this.createRoom.bind(this);
	readonly join = this.joinRoom.bind(this);
	readonly poll = this.pollRoom.bind(this);
	readonly submit = this.submitMessage.bind(this);
	readonly cancel = this.cancelRoom.bind(this);
	constructor(serverUrl: string, signal: AbortSignal) {
		this.origin = pairingOrigin(serverUrl);
		this.signal = signal;
	}

	private async request(
		method: "DELETE",
		path: string,
		payload?: unknown,
		capability?: string | null,
		key?: SigningKey,
	): Promise<null>;
	private async request(
		method: "GET" | "POST",
		path: string,
		payload?: unknown,
		capability?: string | null,
		key?: SigningKey,
	): Promise<Room>;
	private async request(
		method: string,
		path: string,
		payload?: unknown,
		capability?: string | null,
		key?: SigningKey,
	): Promise<Room | null> {
		const body = payload === undefined ? undefined : encode(payload);
		if (body && body.length > MAX_BODY) {
			throw new Error("Pairing message is too large.");
		}
		let authorization: string | undefined;
		if (key) {
			authorization = await authorizationHeader({
				key,
				origin: this.origin,
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
		const combined = AbortSignal.any([this.signal, deadline]);
		combined.throwIfAborted();
		const response = await fetch(new URL(path, this.origin), {
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
			const frame = await readPairingResponse(response);
			if (!Array.isArray(frame) || frame.length !== 7) {
				throw new Error("Invalid pairing response frame.");
			}
			value = {
				v: frame[0],
				id: frame[1],
				instance: frame[2],
				remaining_secs: frame[3],
				step: frame[4],
				message: frame[5],
				capability: frame[6],
			};
		} catch (error) {
			combined.throwIfAborted();
			throw error;
		}
		pairingContext(this.origin, value);
		if (
			typeof value.step !== "number" ||
			!Number.isInteger(value.step) ||
			value.step < 0 ||
			value.step > 7 ||
			typeof value.remaining_secs !== "number" ||
			!Number.isInteger(value.remaining_secs) ||
			value.remaining_secs < 0 ||
			value.remaining_secs > 120 ||
			(value.step === 0
				? value.message !== null
				: !(value.message instanceof Uint8Array) ||
					value.message.length === 0 ||
					value.message.length > (value.step === 4 ? 1024 * 1024 : 8192))
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
				value.capability === null ? undefined : string(value.capability),
			message: value.message === null ? null : binary(value.message),
		};
	}
	private async createRoom(key: SigningKey) {
		return joinedRoom(
			await this.request("POST", "/api/pairings", [1], null, key),
		);
	}
	private async joinRoom(id: string, message: Uint8Array<ArrayBuffer>) {
		if (
			!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(id) ||
			message.length === 0 ||
			message.length > 8192
		) {
			throw new Error("Invalid pairing join.");
		}
		return joinedRoom(
			await this.request("POST", `/api/pairings/${id}/join`, [message]),
		);
	}
	private pollRoom(room: JoinedRoom) {
		return this.request(
			"GET",
			`/api/pairings/${room.id}/messages`,
			undefined,
			room.capability,
		);
	}
	private async submitMessage(
		room: JoinedRoom,
		step: number,
		message: Uint8Array<ArrayBuffer>,
	) {
		if (
			!Number.isInteger(step) ||
			step < 2 ||
			step > 7 ||
			message.length > (step === 4 ? 1024 * 1024 : 8192)
		) {
			throw new Error("Invalid pairing message.");
		}
		return this.request(
			"POST",
			`/api/pairings/${room.id}/messages`,
			[step, message],
			room.capability,
		);
	}
	private async cancelRoom(room: JoinedRoom) {
		await this.request(
			"DELETE",
			`/api/pairings/${room.id}`,
			undefined,
			room.capability,
		);
	}
}
