import { get, type Writable, writable } from "svelte/store";
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

interface PollWait {
	signal: AbortSignal;
	resolve: () => void;
	reject: (error: unknown) => void;
	abort: () => void;
	timer?: ReturnType<typeof setTimeout>;
}
export function createPairing(
	session: PairingSession,
	services: PairingServices = {},
): Pick<PairingStoreImpl, keyof PairingStoreImpl> {
	return new PairingStoreImpl(session, services);
}

class PairingStoreImpl {
	private readonly session: PairingSession;
	private readonly cryptoFactory: () => PairingCrypto;
	private readonly relayFactory: (
		server: string,
		signal: AbortSignal,
	) => PairingRelay;
	private readonly now: () => number;
	private readonly services: PairingServices;
	private readonly log: ReturnType<typeof createLog>;
	private readonly state: Writable<PairingState>;
	private task: Task | null;
	private disposed: boolean;

	readonly subscribe: Writable<PairingState>["subscribe"];
	readonly send = this.sendCommand.bind(this);
	readonly receive = this.receiveCommand.bind(this);
	readonly approve = this.approvePairing.bind(this);
	readonly rejectVerification = this.rejectPairingVerification.bind(this);
	readonly cancel = this.cancelCommand.bind(this);
	readonly dispose = this.disposePairing.bind(this);

	constructor(session: PairingSession, services: PairingServices = {}) {
		this.session = session;
		this.services = services;
		this.cryptoFactory = services.crypto || pairingCrypto;
		this.relayFactory = services.relay || pairingRelay;
		this.now = services.now || (() => performance.now());
		this.log = createLog("pairing");
		this.state = writable<PairingState>({
			active: false,
			approval: false,
			code: "",
			verificationCode: "",
			server: "",
			remaining: 0,
			status: "",
			error: false,
		});
		this.subscribe = this.state.subscribe;
		this.task = null;
		this.disposed = false;
	}

	private sendCommand() {
		return this.runPairing(
			"sender",
			get(this.session).serverUrl,
			this.sendIdentity.bind(this),
		);
	}

	private receiveCommand(code: string, server: string) {
		return this.runPairing("receiver", server, (current) =>
			this.receiveIdentity(current, code),
		);
	}

	private cancelCommand() {
		return this.stopPairing();
	}

	private updatePairing(patch: Partial<PairingState>) {
		if (!this.disposed) {
			this.state.update((value) => ({ ...value, ...patch }));
		}
	}

	private checkTask(current: Task) {
		current.controller.signal.throwIfAborted();
		if (this.now() >= current.deadline || Date.now() >= current.wallDeadline) {
			throw new Error("Pairing expired. Create a new code.");
		}
	}

	private cleanupTask(current: Task, remove: boolean) {
		this.log.debug("cleanup", { operation: current.operation, remove });
		if (!current.controller.signal.aborted) {
			clearInterval(current.timer);
			current.stopWatching();
			current.crypto.dispose();
			current.controller.abort(canceled());
			current.approve?.();
			current.approve = null;
		}
		if (remove && current.room) {
			const room = current.room;
			current.room = null;
			// Cancellation uses its own bounded request, independent of the aborted workflow.
			this.relayFactory(current.server, AbortSignal.timeout(10000))
				.cancel(room)
				.catch((error) =>
					this.log.warn("cleanup-failed", {
						operation: current.operation,
						...failureFields(error),
					}),
				);
		}
	}

	private stopPairing(message = "Pairing canceled. Start again when ready.") {
		if (!this.task) {
			return;
		}
		const current = this.task;
		this.log.debug("cancelled", {
			operation: current.operation,
			role: current.role,
		});
		this.task = null;
		this.cleanupTask(current, true);
		this.updatePairing({
			active: false,
			approval: false,
			code: "",
			verificationCode: "",
			remaining: 0,
			status: message,
			error: false,
		});
	}

	private async waitToPoll(current: Task) {
		this.checkTask(current);
		await new Promise<void>((resolve, reject) =>
			waitPollDelay(
				current.controller.signal,
				this.services.pollMs ?? 1000,
				resolve,
				reject,
			),
		);
		this.checkTask(current);
	}

	private async waitForStep(
		current: Task,
		ownedRoom: JoinedRoom,
		expected: number,
	) {
		while (true) {
			const room = await this.retryPairing(current, () =>
				current.relay.poll(ownedRoom),
			);
			if (room.id !== ownedRoom.id || room.instance !== ownedRoom.instance) {
				throw new Error("Pairing session changed. Create a new code.");
			}
			if (room.step !== current.step) {
				current.step = room.step;
				this.log.debug("step-received", {
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
			await this.waitToPoll(current);
		}
	}

	private async retryPairing<T>(
		current: Task,
		action: () => Promise<T>,
	): Promise<T> {
		this.checkTask(current);
		let result: T;
		try {
			result = await action();
		} catch (error) {
			this.checkTask(current);
			if (
				!["TypeError", "TimeoutError"].includes(
					error instanceof Error ? error.name : "",
				)
			) {
				throw error;
			}
			this.log.debug("retry", {
				operation: current.operation,
				...failureFields(error),
			});
			// Retry only idempotent polls and identical submissions, once.
			await this.waitToPoll(current);
			result = await action();
		}
		this.checkTask(current);
		return result;
	}

	private async usePairingCrypto<T>(
		current: Task,
		operation: (crypto: PairingCrypto) => Promise<T>,
	): Promise<T> {
		this.checkTask(current);
		const result = await operation(current.crypto);
		this.checkTask(current);
		return result;
	}

	private async submitStep(
		current: Task,
		ownedRoom: JoinedRoom,
		number: number,
		message: Uint8Array<ArrayBuffer>,
	) {
		this.log.debug("step-submitting", {
			operation: current.operation,
			step: number,
		});
		const result = await this.retryPairing(current, () =>
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

	private startTask(
		server: string,
		role: "sender" | "receiver",
		operation: number,
	): Task {
		const controller = new AbortController();
		let crypto: PairingCrypto | null = null;
		try {
			const origin = pairingOrigin(server);
			const relay = this.relayFactory(origin, controller.signal);
			crypto = this.cryptoFactory();
			const current: Task = {
				operation,
				role,
				step: -1,
				server: origin,
				controller,
				stopWatching: () => {},
				relay,
				crypto,
				deadline: this.now() + PAIRING_TTL_MS,
				wallDeadline: Date.now() + PAIRING_TTL_MS,
				saved: false,
				room: null,
				approve: null,
				timer: setInterval(() => this.tickPairing(current), 250),
			};
			return current;
		} catch (error) {
			crypto?.dispose();
			controller.abort();
			throw error;
		}
	}

	private watchSession(current: Task) {
		const signal = get(this.session).signal;
		const abort = () =>
			this.stopPairing("Library or server changed. Start pairing again.");
		signal.throwIfAborted();
		signal.addEventListener("abort", abort, { once: true });
		current.stopWatching = () => signal.removeEventListener("abort", abort);
	}

	private async runPairing(
		role: "sender" | "receiver",
		server: string,
		work: (current: Task) => Promise<void>,
	) {
		if (this.disposed || this.task || get(this.session).busy) {
			this.log.debug("rejected", {
				role,
				reason: this.disposed ? "disposed" : "busy",
			});
			return false;
		}
		const operation = this.log.operation();
		this.log.info("started", { role, operation });
		this.updatePairing({
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
			current = this.startTask(server, role, operation);
			this.task = current;
			this.watchSession(current);
		} catch (error) {
			this.log.error("start-failed", {
				operation,
				role,
				...failureFields(error),
			});
			this.updatePairing({
				active: false,
				remaining: 0,
				error: true,
				status: errorMessage(error),
			});
			return false;
		}
		try {
			await work(current);
			this.checkTask(current);
			if (this.task === current) {
				this.updatePairing({
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
			this.log.info("completed", { operation, role });
			this.cleanupTask(current, false);
			return true;
		} catch (error) {
			if (this.task !== current) {
				this.log.debug("stale-completion", { operation, role });
			} else if (current.saved) {
				this.log.warn("confirmation-failed", {
					operation,
					role,
					saved: true,
					...failureFields(error),
				});
			} else {
				this.log.error("failed", {
					operation,
					role,
					saved: false,
					...failureFields(error),
				});
			}
			if (this.task === current) {
				this.updatePairing({
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
			this.cleanupTask(current, !current.saved);
			return current.saved;
		} finally {
			if (this.task === current) {
				this.task = null;
			}
		}
	}

	private attachRoom(current: Task, room: JoinedRoom, id: string) {
		if (room.id !== id) {
			throw new Error("Invalid pairing response.");
		}
		current.room = room;
		this.log.debug("room-attached", {
			operation: current.operation,
			role: current.role,
		});
		const context = pairingContext(current.server, room);
		current.deadline = Math.min(
			current.deadline,
			this.now() + room.remaining_secs * 1000,
		);
		current.wallDeadline = Math.min(
			current.wallDeadline,
			Date.now() + room.remaining_secs * 1000,
		);
		this.checkTask(current);
		return context;
	}

	private async sendIdentity(current: Task) {
		const credentials = this.session.identity();
		this.checkTask(current);
		const room = await current.relay.create(credentials.key);
		const context = this.attachRoom(current, room, room.id);
		const secret = pairingSecret();
		await this.usePairingCrypto(current, async (crypto) =>
			crypto.senderSetup({
				secret,
				context: context,
			}),
		);
		this.updatePairing({
			code: formatPairingCode(room.id, secret),
			status: "Enter this code on the new device. Keep it private.",
		});
		const response = await this.usePairingCrypto(current, (crypto) =>
			this.respondToReceiver(current, room, crypto),
		);
		await this.submitStep(current, room, 2, response);
		await this.usePairingCrypto(current, (crypto) =>
			this.finishSenderAuthentication(current, room, crypto),
		);
		this.updatePairing({
			approval: true,
			code: "",
			verificationCode: await this.usePairingCrypto(current, (crypto) =>
				crypto.verificationCode(),
			),
			status:
				"Compare this code with the new device. Send your library only if they match. This gives it full access.",
		});
		this.log.debug("approval-waiting", { operation: current.operation });
		const approval = { approved: false };
		current.approve = () => {
			approval.approved = true;
		};
		while (!approval.approved) {
			await this.waitToPoll(current);
			// Keep checking the room while the user compares codes, so a
			// receiver cancellation removes the pending approval too.
			await this.waitForStep(current, room, 3);
		}
		current.approve = null;
		this.checkTask(current);
		this.updatePairing({
			approval: false,
			verificationCode: "",
			status: "Sending library…",
		});
		const { privateKey, publicKey } = this.session.identity();
		const packet = await this.usePairingCrypto(current, (crypto) =>
			crypto.transfer({
				value: {
					v: 1,
					server_url: current.server,
					private_key: privateKey,
					public_key: b64urlToBytes(publicKey),
				},
			}),
		);
		await this.submitStep(current, room, 4, packet);
		this.updatePairing({
			status: "Waiting for the new device to save the library…",
		});
		await this.usePairingCrypto(current, (crypto) =>
			this.verifyReceiverAcknowledgment(current, room, crypto),
		);
	}

	private async receiveIdentity(current: Task, code: string) {
		const local = get(this.session);
		if (local.configured) {
			throw new Error("A library is already configured.");
		}
		const { id, secret } = parsePairingCode(code);
		const initial = await this.usePairingCrypto(current, async (crypto) =>
			crypto.receiverStart({ secret }),
		);
		const room = await current.relay.join(id, initial);
		const context = this.attachRoom(current, room, id);
		const finish = await this.usePairingCrypto(current, (crypto) =>
			this.finishReceiverAuthentication(current, room, crypto, context),
		);
		await this.submitStep(current, room, 3, finish);
		this.updatePairing({
			verificationCode: await this.usePairingCrypto(current, (crypto) =>
				crypto.verificationCode(),
			),
			status: "Compare this code on your unlocked device before approving.",
		});
		const input = await this.usePairingCrypto(current, (crypto) =>
			this.receiveTransfer(current, room, crypto),
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
		this.checkTask(current);
		current.stopWatching();
		this.updatePairing({
			verificationCode: "",
			status: "Saving your encrypted library…",
		});
		const saved = await this.session.importPairing({
			...identity,
			public_key: value.public_key,
			signal: current.controller.signal,
		});
		if (!saved) {
			throw new Error(get(this.session).error || "Could not save the library.");
		}
		current.saved = true;
		this.log.info("identity-saved", { operation: current.operation });
		this.checkTask(current);
		// Import intentionally changes the session. Guard confirmation with
		// the newly saved identity's lifetime.
		this.session.identity();
		this.watchSession(current);
		await this.submitStep(
			current,
			room,
			5,
			await this.usePairingCrypto(current, (crypto) => crypto.acknowledge()),
		);
	}

	private approvePairing() {
		if (
			get(this.state).approval &&
			get(this.state).verificationCode &&
			this.task?.approve
		) {
			this.updatePairing({ approval: false });
			this.log.info("approved", { operation: this.task.operation });
			this.task.approve();
		}
	}

	private rejectPairingVerification() {
		if (get(this.state).verificationCode) {
			this.log.warn("verification-rejected", {
				operation: this.task?.operation,
			});
			this.stopPairing(
				"Verification codes did not match. Create a new pairing code.",
			);
		}
	}

	private disposePairing() {
		this.stopPairing();
		this.disposed = true;
	}

	private async respondToReceiver(
		current: Task,
		room: JoinedRoom,
		crypto: PairingCrypto,
	) {
		return crypto.senderResponse({
			message: await this.waitForStep(current, room, 1),
		});
	}

	private async finishSenderAuthentication(
		current: Task,
		room: JoinedRoom,
		crypto: PairingCrypto,
	) {
		return crypto.senderFinish({
			message: await this.waitForStep(current, room, 3),
		});
	}

	private async verifyReceiverAcknowledgment(
		current: Task,
		room: JoinedRoom,
		crypto: PairingCrypto,
	) {
		return crypto.verifyAcknowledgment({
			message: await this.waitForStep(current, room, 5),
		});
	}

	private async finishReceiverAuthentication(
		current: Task,
		room: JoinedRoom,
		crypto: PairingCrypto,
		context: ReturnType<typeof pairingContext>,
	) {
		return crypto.receiverFinish({
			message: await this.waitForStep(current, room, 2),
			context: context,
		});
	}

	private async receiveTransfer(
		current: Task,
		room: JoinedRoom,
		crypto: PairingCrypto,
	) {
		return crypto.receive({
			message: await this.waitForStep(current, room, 4),
		});
	}

	private tickPairing(current: Task) {
		if (this.task !== current) {
			return;
		}
		try {
			this.checkTask(current);
			this.updatePairing({
				remaining: Math.max(
					0,
					Math.ceil((current.deadline - this.now()) / 1000),
				),
			});
		} catch (error) {
			if (!current.controller.signal.aborted) {
				this.log.debug("expired", { operation: current.operation });
			}
			current.controller.abort(error);
			current.crypto.dispose();
			current.approve?.();
		}
	}
}

function waitPollDelay(
	signal: AbortSignal,
	milliseconds: number,
	resolve: () => void,
	reject: (error: unknown) => void,
) {
	const wait: PollWait = {
		signal,
		resolve,
		reject,
		abort: () => abortPollDelay(wait),
	};
	wait.timer = setTimeout(() => finishPollDelay(wait), milliseconds);
	signal.addEventListener("abort", wait.abort, { once: true });
}

function abortPollDelay(wait: PollWait) {
	clearTimeout(wait.timer);
	wait.reject(wait.signal.reason);
}

function finishPollDelay(wait: PollWait) {
	wait.signal.removeEventListener("abort", wait.abort);
	wait.resolve();
}
