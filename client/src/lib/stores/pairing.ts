import { get, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import type { PairingCrypto } from "../pairing/crypto.ts";
import type { JoinedRoom, PairingRelay } from "../pairing/service.ts";
import { pairingCrypto, pairingRelay } from "../pairing/service.ts";
import { b64urlToBytes } from "../protocol/bytes.ts";
import {
	formatPairingCode,
	PAIRING_TTL_MS,
	pairingContext,
	pairingOrigin,
	pairingSecret,
	parsePairingCode,
} from "../protocol/pairing.ts";
import { validateIdentity } from "../protocol/recovery.ts";
import { document } from "../protocol/value.ts";
import type { PairingSession } from "./session.ts";

interface Task {
	operation: number;
	role: "sender" | "receiver";
	step: number;
	server: string;
	controller: AbortController;
	deadline: number;
	wallDeadline: number;
	saved: boolean;
	timer: ReturnType<typeof setInterval>;
	stopWatching: () => void;
	crypto: PairingCrypto;
	relay: PairingRelay;
	approve: (() => void) | null;
	// A room exists only after create/join returns, including after cancellation.
	room: JoinedRoom | null;
}
export interface PairingServices {
	crypto?: () => PairingCrypto;
	relay?: (server: string, signal: AbortSignal) => PairingRelay;
	now?: () => number;
	pollMs?: number;
}
export interface PairingState {
	active: boolean;
	approval: boolean;
	code: string;
	verificationCode: string;
	server: string;
	remaining: number;
	status: string;
	error: boolean;
}
export type Pairing = ReturnType<typeof createPairing>;
const canceled = () => new DOMException("Pairing canceled.", "AbortError");
export function createPairing(
	session: PairingSession,
	services: PairingServices = {},
) {
	const log = createLog("pairing");
	const cryptoFactory = services.crypto || pairingCrypto;
	const relayFactory = services.relay || pairingRelay;
	const now = services.now || (() => performance.now());
	const state = writable<PairingState>({
		active: false,
		approval: false,
		code: "",
		verificationCode: "",
		server: "",
		remaining: 0,
		status: "",
		error: false,
	});
	let task: Task | null = null;
	let disposed = false;
	const update = (patch: Partial<PairingState>) => {
		if (!disposed) {
			state.update((value) => ({ ...value, ...patch }));
		}
	};
	function checkTask(current: Task) {
		current.controller.signal.throwIfAborted();
		if (now() >= current.deadline || Date.now() >= current.wallDeadline) {
			throw new Error("Pairing expired. Create a new code.");
		}
	}
	function cleanup(current: Task, remove: boolean) {
		log.debug("cleanup", { operation: current.operation, remove });
		clearInterval(current.timer);
		current.stopWatching();
		current.crypto.dispose();
		current.controller.abort(canceled());
		current.approve?.();
		current.approve = null;
		if (remove && current.room) {
			// Cancellation uses its own bounded request, independent of the aborted workflow.
			relayFactory(current.server, AbortSignal.timeout(10000))
				.cancel(current.room)
				.catch((error) =>
					log.warn("cleanup-failed", {
						operation: current.operation,
						...failureFields(error),
					}),
				);
		}
	}
	function stop(message = "Pairing canceled. Start again when ready.") {
		if (!task) {
			return;
		}
		const current = task;
		log.debug("cancelled", {
			operation: current.operation,
			role: current.role,
		});
		task = null;
		cleanup(current, true);
		update({
			active: false,
			approval: false,
			code: "",
			verificationCode: "",
			remaining: 0,
			status: message,
			error: false,
		});
	}
	async function waitToPoll(current: Task) {
		checkTask(current);
		await new Promise<void>((resolve, reject) => {
			const signal = current.controller.signal;
			const abort = () => {
				clearTimeout(timer);
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, services.pollMs ?? 1000);
			signal.addEventListener("abort", abort, { once: true });
		});
		checkTask(current);
	}
	async function waitForStep(
		current: Task,
		ownedRoom: JoinedRoom,
		expected: number,
	) {
		while (true) {
			const room = await retry(current, () => current.relay.poll(ownedRoom));
			if (room.id !== ownedRoom.id || room.instance !== ownedRoom.instance) {
				throw new Error("Pairing session changed. Create a new code.");
			}
			if (room.step !== current.step) {
				current.step = room.step;
				log.debug("step-received", {
					operation: current.operation,
					step: room.step,
				});
			}
			if (room.step === expected) {
				if (!room.message) {
					throw new Error("Invalid pairing response.");
				}
				return room.message;
			}
			if (room.step > expected) {
				throw new Error("Invalid pairing step.");
			}
			await waitToPoll(current);
		}
	}
	async function retry<T>(current: Task, action: () => Promise<T>): Promise<T> {
		checkTask(current);
		let result: T;
		try {
			result = await action();
		} catch (error) {
			checkTask(current);
			if (
				!["TypeError", "TimeoutError"].includes(
					error instanceof Error ? error.name : "",
				)
			) {
				throw error;
			}
			log.debug("retry", {
				operation: current.operation,
				...failureFields(error),
			});
			// Retry only idempotent polls and identical submissions, once.
			await waitToPoll(current);
			result = await action();
		}
		checkTask(current);
		return result;
	}
	async function useCrypto<T>(
		current: Task,
		operation: (crypto: PairingCrypto) => Promise<T>,
	): Promise<T> {
		checkTask(current);
		const result = await operation(current.crypto);
		checkTask(current);
		return result;
	}
	async function submit(
		current: Task,
		ownedRoom: JoinedRoom,
		number: number,
		message: Uint8Array<ArrayBuffer>,
	) {
		log.debug("step-submitting", {
			operation: current.operation,
			step: number,
		});
		const result = await retry(current, () =>
			current.relay.submit(ownedRoom, number, message),
		);
		if (
			result.id !== ownedRoom.id ||
			result.instance !== ownedRoom.instance ||
			result.step < number ||
			result.step > Math.min(5, number + 1)
		) {
			throw new Error("Invalid pairing step.");
		}
	}
	function startTask(
		server: string,
		role: "sender" | "receiver",
		operation: number,
	): Task {
		const controller = new AbortController();
		let crypto: PairingCrypto | null = null;
		try {
			const origin = pairingOrigin(server);
			const relay = relayFactory(origin, controller.signal);
			crypto = cryptoFactory();
			const current: Task = {
				operation,
				role,
				step: -1,
				server: origin,
				controller,
				stopWatching: () => {},
				relay,
				crypto,
				deadline: now() + PAIRING_TTL_MS,
				wallDeadline: Date.now() + PAIRING_TTL_MS,
				saved: false,
				room: null,
				approve: null,
				timer: setInterval(() => {
					if (task !== current) {
						return;
					}
					try {
						checkTask(current);
						update({
							remaining: Math.max(
								0,
								Math.ceil((current.deadline - now()) / 1000),
							),
						});
					} catch (error) {
						if (!current.controller.signal.aborted) {
							log.debug("expired", { operation: current.operation });
						}
						current.controller.abort(error);
						current.crypto.dispose();
						current.approve?.();
					}
				}, 250),
			};
			return current;
		} catch (error) {
			crypto?.dispose();
			controller.abort();
			throw error;
		}
	}
	function watchSession(current: Task) {
		const signal = get(session).signal;
		const abort = () => stop("Library or server changed. Start pairing again.");
		signal.throwIfAborted();
		signal.addEventListener("abort", abort, { once: true });
		current.stopWatching = () => signal.removeEventListener("abort", abort);
	}

	async function run(
		role: "sender" | "receiver",
		server: string,
		work: (current: Task) => Promise<void>,
	) {
		if (disposed || task || get(session).busy) {
			log.debug("rejected", { role, reason: disposed ? "disposed" : "busy" });
			return false;
		}
		const operation = log.operation();
		log.info("started", { role, operation });
		update({
			active: true,
			approval: false,
			code: "",
			verificationCode: "",
			server,
			remaining: 120,
			status: "Preparing secure pairing…",
			error: false,
		});
		let current: Task;
		try {
			current = startTask(server, role, operation);
			task = current;
			watchSession(current);
		} catch (error) {
			log.error("start-failed", { operation, role, ...failureFields(error) });
			update({
				active: false,
				remaining: 0,
				error: true,
				status: errorMessage(error),
			});
			return false;
		}
		try {
			await work(current);
			checkTask(current);
			if (task === current) {
				update({
					active: false,
					approval: false,
					code: "",
					verificationCode: "",
					remaining: 0,
					error: false,
					status:
						role === "sender"
							? "New device connected."
							: "Library connected and unlocked. Download a recovery file for this device.",
				});
			}
			log.info("completed", { operation, role });
			cleanup(current, false);
			return true;
		} catch (error) {
			if (task !== current) {
				log.debug("stale-completion", { operation, role });
			} else if (current.saved) {
				log.warn("confirmation-failed", {
					operation,
					role,
					saved: true,
					...failureFields(error),
				});
			} else {
				log.error("failed", {
					operation,
					role,
					saved: false,
					...failureFields(error),
				});
			}
			if (task === current) {
				update({
					active: false,
					approval: false,
					code: "",
					verificationCode: "",
					remaining: 0,
					error: true,
					status: current.saved
						? "Library saved and unlocked, but confirmation failed. Check the new device before retrying."
						: (error instanceof Error ? error.name : "") === "AbortError" ||
								(error instanceof Error ? error.name : "") === "TimeoutError"
							? "Pairing interrupted. Create a new code."
							: errorMessage(error),
				});
			}
			cleanup(current, !current.saved);
			return current.saved;
		} finally {
			if (task === current) {
				task = null;
			}
		}
	}
	function attach(current: Task, room: JoinedRoom, id: string) {
		if (room.id !== id) {
			throw new Error("Invalid pairing response.");
		}
		current.room = room;
		log.debug("room-attached", {
			operation: current.operation,
			role: current.role,
		});
		const context = pairingContext(current.server, room);
		current.deadline = Math.min(
			current.deadline,
			now() + room.remaining_secs * 1000,
		);
		current.wallDeadline = Math.min(
			current.wallDeadline,
			Date.now() + room.remaining_secs * 1000,
		);
		checkTask(current);
		return context;
	}
	async function send(current: Task) {
		const credentials = session.identity();
		checkTask(current);
		const room = await current.relay.create(credentials.key);
		const context = attach(current, room, room.id);
		const secret = pairingSecret();
		await useCrypto(current, async (crypto) =>
			crypto.senderSetup({
				secret,
				context: context,
			}),
		);
		update({
			code: formatPairingCode(room.id, secret),
			status: "Enter this code on the new device. Keep it private.",
		});
		const response = await useCrypto(current, async (crypto) =>
			crypto.senderResponse({
				message: await waitForStep(current, room, 1),
			}),
		);
		await submit(current, room, 2, response);
		await useCrypto(current, async (crypto) =>
			crypto.senderFinish({
				message: await waitForStep(current, room, 3),
			}),
		);
		update({
			approval: true,
			code: "",
			verificationCode: await useCrypto(current, (crypto) =>
				crypto.verificationCode(),
			),
			status:
				"Compare this code with the new device. Send your library only if they match. This gives it full access.",
		});
		log.debug("approval-waiting", { operation: current.operation });
		let approved = false;
		current.approve = () => {
			approved = true;
		};
		while (!approved) {
			await waitToPoll(current);
			// Keep checking the room while the user compares codes, so a
			// receiver cancellation removes the pending approval too.
			await waitForStep(current, room, 3);
		}
		current.approve = null;
		checkTask(current);
		update({
			approval: false,
			verificationCode: "",
			status: "Sending library…",
		});
		const { privateKey, publicKey } = session.identity();
		const packet = await useCrypto(current, (crypto) =>
			crypto.transfer({
				value: {
					v: 1,
					server_url: current.server,
					private_key: privateKey,
					public_key: b64urlToBytes(publicKey),
				},
			}),
		);
		await submit(current, room, 4, packet);
		update({ status: "Waiting for the new device to save the library…" });
		await useCrypto(current, async (crypto) =>
			crypto.verifyAcknowledgment({
				message: await waitForStep(current, room, 5),
			}),
		);
	}
	async function receive(current: Task, code: string) {
		const local = get(session);
		if (local.configured) {
			throw new Error("A library is already configured.");
		}
		const { id, secret } = parsePairingCode(code);
		const initial = await useCrypto(current, async (crypto) =>
			crypto.receiverStart({ secret }),
		);
		const room = await current.relay.join(id, initial);
		const context = attach(current, room, id);
		const finish = await useCrypto(current, async (crypto) =>
			crypto.receiverFinish({
				message: await waitForStep(current, room, 2),
				context: context,
			}),
		);
		await submit(current, room, 3, finish);
		update({
			verificationCode: await useCrypto(current, (crypto) =>
				crypto.verificationCode(),
			),
			status: "Compare this code on your unlocked device before approving.",
		});
		const input = await useCrypto(current, async (crypto) =>
			crypto.receive({
				message: await waitForStep(current, room, 4),
			}),
		);
		const value = document(input);
		if (
			value.v !== 1 ||
			value.server_url !== current.server ||
			document(value.private_key).v !== 1 ||
			!(value.public_key instanceof Uint8Array) ||
			value.public_key.length !== 32
		) {
			throw new Error("Invalid paired identity.");
		}
		const identity = (await validateIdentity(value)).identity;
		checkTask(current);
		current.stopWatching();
		update({
			verificationCode: "",
			status: "Saving your encrypted library…",
		});
		const saved = await session.importPairing({
			...identity,
			public_key: value.public_key,
			signal: current.controller.signal,
		});
		if (!saved) {
			throw new Error(get(session).error || "Could not save the library.");
		}
		current.saved = true;
		log.info("identity-saved", { operation: current.operation });
		checkTask(current);
		// Import intentionally changes the session. Guard confirmation with
		// the newly saved identity's lifetime.
		session.identity();
		watchSession(current);
		await submit(
			current,
			room,
			5,
			await useCrypto(current, (crypto) => crypto.acknowledge()),
		);
	}
	return {
		subscribe: state.subscribe,
		send: () => run("sender", get(session).serverUrl, send),
		receive: (code: string, server: string) =>
			run("receiver", server, (current) => receive(current, code)),
		approve() {
			if (get(state).approval && get(state).verificationCode && task?.approve) {
				update({ approval: false });
				log.info("approved", { operation: task.operation });
				task.approve();
			}
		},
		rejectVerification() {
			if (get(state).verificationCode) {
				log.warn("verification-rejected", { operation: task?.operation });
				stop("Verification codes did not match. Create a new pairing code.");
			}
		},
		cancel: () => stop(),
		dispose() {
			stop();
			disposed = true;
		},
	};
}
