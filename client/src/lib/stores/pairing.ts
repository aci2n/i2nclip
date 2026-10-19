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
interface PairingDependencies {
	session: PairingSession;
	cryptoFactory: () => PairingCrypto;
	relayFactory: (server: string, signal: AbortSignal) => PairingRelay;
	now: () => number;
	services: PairingServices;
	log: ReturnType<typeof createLog>;
}
interface PairingRuntime {
	state: Writable<PairingState>;
	task: Task | null;
	disposed: boolean;
}

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
) {
	const deps: PairingDependencies = {
		session,
		services,
		cryptoFactory: services.crypto || pairingCrypto,
		relayFactory: services.relay || pairingRelay,
		now: services.now || (() => performance.now()),
		log: createLog("pairing"),
	};
	const runtime: PairingRuntime = {
		state: writable<PairingState>({
			active: false,
			approval: false,
			code: "",
			verificationCode: "",
			server: "",
			remaining: 0,
			status: "",
			error: false,
		}),
		task: null,
		disposed: false,
	};

	return {
		subscribe: runtime.state.subscribe,
		send: () =>
			runPairing(
				deps,
				runtime,
				"sender",
				get(deps.session).serverUrl,
				sendIdentity.bind(null, deps, runtime),
			),
		receive: (code: string, server: string) =>
			runPairing(deps, runtime, "receiver", server, (current) =>
				receiveIdentity(deps, runtime, current, code),
			),
		approve: approvePairing.bind(null, deps, runtime),
		rejectVerification: rejectPairingVerification.bind(null, deps, runtime),
		cancel: () => stopPairing(deps, runtime),
		dispose: disposePairing.bind(null, deps, runtime),
	};
}

function updatePairing(runtime: PairingRuntime, patch: Partial<PairingState>) {
	if (!runtime.disposed) {
		runtime.state.update((value) => ({ ...value, ...patch }));
	}
}

function checkTask(deps: PairingDependencies, current: Task) {
	current.controller.signal.throwIfAborted();
	if (deps.now() >= current.deadline || Date.now() >= current.wallDeadline) {
		throw new Error("Pairing expired. Create a new code.");
	}
}

function cleanupTask(
	deps: PairingDependencies,
	current: Task,
	remove: boolean,
) {
	deps.log.debug("cleanup", { operation: current.operation, remove });
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
		deps
			.relayFactory(current.server, AbortSignal.timeout(10000))
			.cancel(room)
			.catch((error) =>
				deps.log.warn("cleanup-failed", {
					operation: current.operation,
					...failureFields(error),
				}),
			);
	}
}

function stopPairing(
	deps: PairingDependencies,
	runtime: PairingRuntime,
	message = "Pairing canceled. Start again when ready.",
) {
	if (!runtime.task) {
		return;
	}
	const current = runtime.task;
	deps.log.debug("cancelled", {
		operation: current.operation,
		role: current.role,
	});
	runtime.task = null;
	cleanupTask(deps, current, true);
	updatePairing(runtime, {
		active: false,
		approval: false,
		code: "",
		verificationCode: "",
		remaining: 0,
		status: message,
		error: false,
	});
}

async function waitToPoll(deps: PairingDependencies, current: Task) {
	checkTask(deps, current);
	await new Promise<void>((resolve, reject) =>
		waitPollDelay(
			current.controller.signal,
			deps.services.pollMs ?? 1000,
			resolve,
			reject,
		),
	);
	checkTask(deps, current);
}

async function waitForStep(
	deps: PairingDependencies,
	current: Task,
	ownedRoom: JoinedRoom,
	expected: number,
) {
	while (true) {
		const room = await retryPairing(deps, current, () =>
			current.relay.poll(ownedRoom),
		);
		if (room.id !== ownedRoom.id || room.instance !== ownedRoom.instance) {
			throw new Error("Pairing session changed. Create a new code.");
		}
		if (room.step !== current.step) {
			current.step = room.step;
			deps.log.debug("step-received", {
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
		await waitToPoll(deps, current);
	}
}

async function retryPairing<T>(
	deps: PairingDependencies,
	current: Task,
	action: () => Promise<T>,
): Promise<T> {
	checkTask(deps, current);
	let result: T;
	try {
		result = await action();
	} catch (error) {
		checkTask(deps, current);
		if (
			!["TypeError", "TimeoutError"].includes(
				error instanceof Error ? error.name : "",
			)
		) {
			throw error;
		}
		deps.log.debug("retry", {
			operation: current.operation,
			...failureFields(error),
		});
		// Retry only idempotent polls and identical submissions, once.
		await waitToPoll(deps, current);
		result = await action();
	}
	checkTask(deps, current);
	return result;
}

async function usePairingCrypto<T>(
	deps: PairingDependencies,
	current: Task,
	operation: (crypto: PairingCrypto) => Promise<T>,
): Promise<T> {
	checkTask(deps, current);
	const result = await operation(current.crypto);
	checkTask(deps, current);
	return result;
}

async function submitStep(
	deps: PairingDependencies,
	current: Task,
	ownedRoom: JoinedRoom,
	number: number,
	message: Uint8Array<ArrayBuffer>,
) {
	deps.log.debug("step-submitting", {
		operation: current.operation,
		step: number,
	});
	const result = await retryPairing(deps, current, () =>
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
	deps: PairingDependencies,
	runtime: PairingRuntime,
	server: string,
	role: "sender" | "receiver",
	operation: number,
): Task {
	const controller = new AbortController();
	let crypto: PairingCrypto | null = null;
	try {
		const origin = pairingOrigin(server);
		const relay = deps.relayFactory(origin, controller.signal);
		crypto = deps.cryptoFactory();
		const current: Task = {
			operation,
			role,
			step: -1,
			server: origin,
			controller,
			stopWatching: () => {},
			relay,
			crypto,
			deadline: deps.now() + PAIRING_TTL_MS,
			wallDeadline: Date.now() + PAIRING_TTL_MS,
			saved: false,
			room: null,
			approve: null,
			timer: setInterval(() => tickPairing(deps, runtime, current), 250),
		};
		return current;
	} catch (error) {
		crypto?.dispose();
		controller.abort();
		throw error;
	}
}

function watchSession(
	deps: PairingDependencies,
	runtime: PairingRuntime,
	current: Task,
) {
	const signal = get(deps.session).signal;
	const abort = () =>
		stopPairing(
			deps,
			runtime,
			"Library or server changed. Start pairing again.",
		);
	signal.throwIfAborted();
	signal.addEventListener("abort", abort, { once: true });
	current.stopWatching = () => signal.removeEventListener("abort", abort);
}

async function runPairing(
	deps: PairingDependencies,
	runtime: PairingRuntime,
	role: "sender" | "receiver",
	server: string,
	work: (current: Task) => Promise<void>,
) {
	if (runtime.disposed || runtime.task || get(deps.session).busy) {
		deps.log.debug("rejected", {
			role,
			reason: runtime.disposed ? "disposed" : "busy",
		});
		return false;
	}
	const operation = deps.log.operation();
	deps.log.info("started", { role, operation });
	updatePairing(runtime, {
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
		current = startTask(deps, runtime, server, role, operation);
		runtime.task = current;
		watchSession(deps, runtime, current);
	} catch (error) {
		deps.log.error("start-failed", {
			operation,
			role,
			...failureFields(error),
		});
		updatePairing(runtime, {
			active: false,
			remaining: 0,
			error: true,
			status: errorMessage(error),
		});
		return false;
	}
	try {
		await work(current);
		checkTask(deps, current);
		if (runtime.task === current) {
			updatePairing(runtime, {
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
		deps.log.info("completed", { operation, role });
		cleanupTask(deps, current, false);
		return true;
	} catch (error) {
		if (runtime.task !== current) {
			deps.log.debug("stale-completion", { operation, role });
		} else if (current.saved) {
			deps.log.warn("confirmation-failed", {
				operation,
				role,
				saved: true,
				...failureFields(error),
			});
		} else {
			deps.log.error("failed", {
				operation,
				role,
				saved: false,
				...failureFields(error),
			});
		}
		if (runtime.task === current) {
			updatePairing(runtime, {
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
		cleanupTask(deps, current, !current.saved);
		return current.saved;
	} finally {
		if (runtime.task === current) {
			runtime.task = null;
		}
	}
}

function attachRoom(
	deps: PairingDependencies,
	current: Task,
	room: JoinedRoom,
	id: string,
) {
	if (room.id !== id) {
		throw new Error("Invalid pairing response.");
	}
	current.room = room;
	deps.log.debug("room-attached", {
		operation: current.operation,
		role: current.role,
	});
	const context = pairingContext(current.server, room);
	current.deadline = Math.min(
		current.deadline,
		deps.now() + room.remaining_secs * 1000,
	);
	current.wallDeadline = Math.min(
		current.wallDeadline,
		Date.now() + room.remaining_secs * 1000,
	);
	checkTask(deps, current);
	return context;
}

async function sendIdentity(
	deps: PairingDependencies,
	runtime: PairingRuntime,
	current: Task,
) {
	const credentials = deps.session.identity();
	checkTask(deps, current);
	const room = await current.relay.create(credentials.key);
	const context = attachRoom(deps, current, room, room.id);
	const secret = pairingSecret();
	await usePairingCrypto(deps, current, async (crypto) =>
		crypto.senderSetup({
			secret,
			context: context,
		}),
	);
	updatePairing(runtime, {
		code: formatPairingCode(room.id, secret),
		status: "Enter this code on the new device. Keep it private.",
	});
	const response = await usePairingCrypto(deps, current, (crypto) =>
		respondToReceiver(deps, current, room, crypto),
	);
	await submitStep(deps, current, room, 2, response);
	await usePairingCrypto(deps, current, (crypto) =>
		finishSenderAuthentication(deps, current, room, crypto),
	);
	updatePairing(runtime, {
		approval: true,
		code: "",
		verificationCode: await usePairingCrypto(deps, current, (crypto) =>
			crypto.verificationCode(),
		),
		status:
			"Compare this code with the new device. Send your library only if they match. This gives it full access.",
	});
	deps.log.debug("approval-waiting", { operation: current.operation });
	const approval = { approved: false };
	current.approve = () => {
		approval.approved = true;
	};
	while (!approval.approved) {
		await waitToPoll(deps, current);
		// Keep checking the room while the user compares codes, so a
		// receiver cancellation removes the pending approval too.
		await waitForStep(deps, current, room, 3);
	}
	current.approve = null;
	checkTask(deps, current);
	updatePairing(runtime, {
		approval: false,
		verificationCode: "",
		status: "Sending library…",
	});
	const { privateKey, publicKey } = deps.session.identity();
	const packet = await usePairingCrypto(deps, current, (crypto) =>
		crypto.transfer({
			value: {
				v: 1,
				server_url: current.server,
				private_key: privateKey,
				public_key: b64urlToBytes(publicKey),
			},
		}),
	);
	await submitStep(deps, current, room, 4, packet);
	updatePairing(runtime, {
		status: "Waiting for the new device to save the library…",
	});
	await usePairingCrypto(deps, current, (crypto) =>
		verifyReceiverAcknowledgment(deps, current, room, crypto),
	);
}

async function receiveIdentity(
	deps: PairingDependencies,
	runtime: PairingRuntime,
	current: Task,
	code: string,
) {
	const local = get(deps.session);
	if (local.configured) {
		throw new Error("A library is already configured.");
	}
	const { id, secret } = parsePairingCode(code);
	const initial = await usePairingCrypto(deps, current, async (crypto) =>
		crypto.receiverStart({ secret }),
	);
	const room = await current.relay.join(id, initial);
	const context = attachRoom(deps, current, room, id);
	const finish = await usePairingCrypto(deps, current, (crypto) =>
		finishReceiverAuthentication(deps, current, room, crypto, context),
	);
	await submitStep(deps, current, room, 3, finish);
	updatePairing(runtime, {
		verificationCode: await usePairingCrypto(deps, current, (crypto) =>
			crypto.verificationCode(),
		),
		status: "Compare this code on your unlocked device before approving.",
	});
	const input = await usePairingCrypto(deps, current, (crypto) =>
		receiveTransfer(deps, current, room, crypto),
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
	checkTask(deps, current);
	current.stopWatching();
	updatePairing(runtime, {
		verificationCode: "",
		status: "Saving your encrypted library…",
	});
	const saved = await deps.session.importPairing({
		...identity,
		public_key: value.public_key,
		signal: current.controller.signal,
	});
	if (!saved) {
		throw new Error(get(deps.session).error || "Could not save the library.");
	}
	current.saved = true;
	deps.log.info("identity-saved", { operation: current.operation });
	checkTask(deps, current);
	// Import intentionally changes the session. Guard confirmation with
	// the newly saved identity's lifetime.
	deps.session.identity();
	watchSession(deps, runtime, current);
	await submitStep(
		deps,
		current,
		room,
		5,
		await usePairingCrypto(deps, current, (crypto) => crypto.acknowledge()),
	);
}

function approvePairing(deps: PairingDependencies, runtime: PairingRuntime) {
	if (
		get(runtime.state).approval &&
		get(runtime.state).verificationCode &&
		runtime.task?.approve
	) {
		updatePairing(runtime, { approval: false });
		deps.log.info("approved", { operation: runtime.task.operation });
		runtime.task.approve();
	}
}

function rejectPairingVerification(
	deps: PairingDependencies,
	runtime: PairingRuntime,
) {
	if (get(runtime.state).verificationCode) {
		deps.log.warn("verification-rejected", {
			operation: runtime.task?.operation,
		});
		stopPairing(
			deps,
			runtime,
			"Verification codes did not match. Create a new pairing code.",
		);
	}
}

function disposePairing(deps: PairingDependencies, runtime: PairingRuntime) {
	stopPairing(deps, runtime);
	runtime.disposed = true;
}

async function respondToReceiver(
	deps: PairingDependencies,
	current: Task,
	room: JoinedRoom,
	crypto: PairingCrypto,
) {
	return crypto.senderResponse({
		message: await waitForStep(deps, current, room, 1),
	});
}

async function finishSenderAuthentication(
	deps: PairingDependencies,
	current: Task,
	room: JoinedRoom,
	crypto: PairingCrypto,
) {
	return crypto.senderFinish({
		message: await waitForStep(deps, current, room, 3),
	});
}

async function verifyReceiverAcknowledgment(
	deps: PairingDependencies,
	current: Task,
	room: JoinedRoom,
	crypto: PairingCrypto,
) {
	return crypto.verifyAcknowledgment({
		message: await waitForStep(deps, current, room, 5),
	});
}

async function finishReceiverAuthentication(
	deps: PairingDependencies,
	current: Task,
	room: JoinedRoom,
	crypto: PairingCrypto,
	context: ReturnType<typeof pairingContext>,
) {
	return crypto.receiverFinish({
		message: await waitForStep(deps, current, room, 2),
		context: context,
	});
}

async function receiveTransfer(
	deps: PairingDependencies,
	current: Task,
	room: JoinedRoom,
	crypto: PairingCrypto,
) {
	return crypto.receive({
		message: await waitForStep(deps, current, room, 4),
	});
}

function tickPairing(
	deps: PairingDependencies,
	runtime: PairingRuntime,
	current: Task,
) {
	if (runtime.task !== current) {
		return;
	}
	try {
		checkTask(deps, current);
		updatePairing(runtime, {
			remaining: Math.max(0, Math.ceil((current.deadline - deps.now()) / 1000)),
		});
	} catch (error) {
		if (!current.controller.signal.aborted) {
			deps.log.debug("expired", { operation: current.operation });
		}
		current.controller.abort(error);
		current.crypto.dispose();
		current.approve?.();
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
