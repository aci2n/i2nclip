import { get, writable } from "svelte/store";
import { pairingCrypto, pairingRelay } from "../pairing/service.js";
import { b64urlToBytes } from "../protocol/bytes.js";
import {
	formatPairingCode,
	PAIRING_TTL_MS,
	pairingContext,
	pairingOrigin,
	pairingSecret,
	parsePairingCode,
} from "../protocol/pairing.js";

const canceled = () => new DOMException("Pairing canceled.", "AbortError");

export function createPairing(session, services = {}) {
	const cryptoFactory = services.crypto || pairingCrypto;
	const relayFactory = services.relay || pairingRelay;
	const now = services.now || (() => performance.now());
	const state = writable({
		active: false,
		approval: false,
		code: "",
		verificationCode: "",
		server: "",
		remaining: 0,
		status: "",
		error: false,
	});
	let task;
	let disposed = false;
	const update = (patch) => {
		if (!disposed) {
			state.update((value) => ({ ...value, ...patch }));
		}
	};
	function check(current) {
		current.controller.signal.throwIfAborted();
		if (now() >= current.deadline || Date.now() >= current.wallDeadline) {
			throw new Error("Pairing expired. Create a new code.");
		}
	}

	function cleanup(current, remove) {
		clearInterval(current.timer);
		current.operation?.dispose();
		current.crypto?.dispose();
		current.controller.abort(canceled());
		current.approve?.();
		current.approve = null;
		if (remove && current.room) {
			// Cancellation uses its own bounded request, independent of the aborted workflow.
			relayFactory(current.server, AbortSignal.timeout(10_000))
				.cancel(current.room)
				.catch(() => {});
		}
	}
	function stop(message = "Pairing canceled. Start again when ready.") {
		if (!task) {
			return;
		}

		const current = task;
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

	async function wait(current) {
		check(current);
		await new Promise((resolve, reject) => {
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
		check(current);
	}
	async function step(current, expected) {
		while (true) {
			check(current);
			const room = await retry(current, () => current.relay.poll(current.room));
			check(current);
			if (
				room.id !== current.room.id ||
				room.instance !== current.room.instance
			) {
				throw new Error("Pairing session changed. Create a new code.");
			}
			if (room.step === expected) {
				return room.message;
			}
			if (room.step > expected) {
				throw new Error("Invalid pairing step.");
			}
			await wait(current);
		}
	}
	async function retry(current, action) {
		try {
			return await action();
		} catch (error) {
			check(current);
			if (!["TypeError", "TimeoutError"].includes(error.name)) {
				throw error;
			}
			// Polls and identical submissions are idempotent. Never repeat room
			// creation/join or generate another PAKE message for this attempt.
			await wait(current);
			return action();
		}
	}
	async function call(current, action, args) {
		check(current);
		const result = await current.crypto.call(action, args);
		check(current);
		return result;
	}
	async function verification(current) {
		const code = await call(current, "verificationCode");
		if (
			typeof code !== "string" ||
			!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(
				code,
			)
		) {
			throw new Error("Invalid verification code. Create a new pairing code.");
		}
		return code;
	}
	async function submit(current, number, message) {
		check(current);
		const result = await retry(current, () =>
			current.relay.submit(current.room, number, message),
		);
		check(current);
		if (
			result.id !== current.room.id ||
			result.instance !== current.room.instance ||
			result.step < number ||
			result.step > Math.min(5, number + 1)
		) {
			throw new Error("Invalid pairing step.");
		}
	}
	async function run(role, server, operation) {
		if (disposed || task || get(session).busy) {
			return false;
		}

		const current = {
			role,
			server: "",
			controller: new AbortController(),
			deadline: now() + PAIRING_TTL_MS,
			wallDeadline: Date.now() + PAIRING_TTL_MS,
			saved: false,
		};
		task = current;
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
		try {
			current.operation = session.operation({
				signal: current.controller.signal,
				onInvalidated: () =>
					stop("Library or server changed. Start pairing again."),
			});
			current.server = pairingOrigin(server);
			current.relay = relayFactory(current.server, current.controller.signal);
			current.crypto = cryptoFactory();
			current.timer = setInterval(() => {
				if (task !== current) {
					return;
				}
				try {
					check(current);
					update({
						remaining: Math.max(
							0,
							Math.ceil((current.deadline - now()) / 1000),
						),
					});
				} catch (error) {
					current.controller.abort(error);
					current.crypto.dispose();
					current.approve?.();
				}
			}, 250);
			await operation(current);
			check(current);
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
			cleanup(current, false);

			return true;
		} catch (error) {
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
						: error.name === "AbortError" || error.name === "TimeoutError"
							? "Pairing interrupted. Create a new code."
							: error.message,
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
	function attach(current, room, id) {
		if (room.id !== id || !/^[A-Za-z0-9_-]{43}$/.test(room.capability)) {
			throw new Error("Invalid pairing response.");
		}
		current.room = room;
		current.context = pairingContext(current.server, room);
		current.deadline = Math.min(
			current.deadline,
			now() + room.remaining_secs * 1000,
		);
		current.wallDeadline = Math.min(
			current.wallDeadline,
			Date.now() + room.remaining_secs * 1000,
		);
		check(current);
	}
	return {
		subscribe: state.subscribe,
		send() {
			const value = get(session);
			return run("sender", value.serverUrl, async (current) => {
				const credentials = await session.withIdentity(
					current.operation,
					(identity) => identity,
				);
				check(current);
				const room = await current.relay.create(credentials.key);
				attach(current, room, room.id);
				const secret = pairingSecret();
				await call(current, "senderSetup", {
					secret,
					context: current.context,
				});
				update({
					code: formatPairingCode(room.id, secret),
					status: "Enter this code on the new device. Keep it private.",
				});
				const response = await call(current, "senderResponse", {
					message: await step(current, 1),
				});
				await submit(current, 2, response);
				await call(current, "senderFinish", {
					message: await step(current, 3),
				});
				update({
					approval: true,
					code: "",
					verificationCode: await verification(current),
					status:
						"Compare this code with the new device. Send your library only if they match. This gives it full access.",
				});
				let approved = false;
				current.approve = () => {
					approved = true;
				};
				while (!approved) {
					await wait(current);
					// Keep checking the room while the user compares codes, so a
					// receiver cancellation removes the pending approval too.
					await step(current, 3);
				}
				current.approve = null;
				check(current);
				update({
					approval: false,
					verificationCode: "",
					status: "Sending library…",
				});
				await session.withIdentity(
					current.operation,
					async ({ privateKey, publicKey }) => {
						const packet = await call(current, "transfer", {
							value: {
								v: 1,
								server_url: current.server,
								private_key: privateKey,
								public_key: b64urlToBytes(publicKey),
							},
						});
						await submit(current, 4, packet);
					},
				);
				update({ status: "Waiting for the new device to save the library…" });
				await call(current, "verifyAcknowledgment", {
					message: await step(current, 5),
				});
			});
		},
		receive(code, server) {
			return run("receiver", server, async (current) => {
				const local = get(session);
				if (local.configured) {
					throw new Error("A library is already configured.");
				}
				const { id, secret } = parsePairingCode(code);
				const initial = await call(current, "receiverStart", { secret });
				attach(current, await current.relay.join(id, initial), id);
				const finish = await call(current, "receiverFinish", {
					message: await step(current, 2),
					context: current.context,
				});
				await submit(current, 3, finish);
				update({
					verificationCode: await verification(current),
					status: "Compare this code on your unlocked device before approving.",
				});
				const value = await call(current, "receive", {
					message: await step(current, 4),
				});
				if (
					value?.v !== 1 ||
					value.server_url !== current.server ||
					value.private_key?.v !== 1 ||
					!(value.public_key instanceof Uint8Array) ||
					value.public_key.length !== 32
				) {
					throw new Error("Invalid paired identity.");
				}
				current.operation.dispose();
				update({
					verificationCode: "",
					status: "Saving your encrypted library…",
				});
				const savedOperation = await session.importPairing({
					...value,
					signal: current.controller.signal,
					onInvalidated: () =>
						stop("Library or server changed. Start pairing again."),
				});
				if (!savedOperation) {
					throw new Error(get(session).error || "Could not save the library.");
				}
				current.saved = true;
				current.operation = savedOperation;
				const acknowledge = async () => {
					check(current);
					await submit(current, 5, await call(current, "acknowledge"));
				};
				await session.withIdentity(current.operation, acknowledge);
			});
		},
		approve() {
			if (get(state).approval && get(state).verificationCode && task?.approve) {
				update({ approval: false });
				task.approve();
			}
		},
		rejectVerification() {
			if (get(state).verificationCode) {
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
