import { get, writable } from "svelte/store";

/** @typedef {import("./contract.js").ServiceTransport} ServiceTransport */

// Both hosts feed this same adapter. No owner workflows or credentials live here.
export function createServiceClient(
	connect,
	{ helper, browser = globalThis.window } = {},
) {
	const initial = () => ({
		catalog: [],
		libraries: {},
		connected: false,
		instanceId: null,
		clientId: null,
		session: {
			ready: false,
			configured: false,
			unlocked: false,
			serverUrl: "",
			pendingRegistration: null,
			busy: false,
			error: "",
			epoch: 0,
		},
		uploads: [],
		pairing: { active: false },
		media: {},
		views: {},
	});
	const state = writable(initial());
	const pending = new Map();
	let transport;
	let unlisten;
	let unDisconnect;
	let instanceId;
	let sequence = 0;
	let disposed = false;
	let reconnect;
	let lastMessage = Date.now();
	let resyncing = false;
	let hidden = false;
	let connecting = false;
	let resolveReady, rejectReady;
	const ready = new Promise((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	ready.catch(() => {});
	function rejectPending() {
		for (const job of pending.values())
			job.reject(
				new Error(
					"Service disconnected. The action may have completed; check its status before retrying.",
				),
			);
		pending.clear();
	}
	function lost() {
		if (disposed) return;
		connecting = false;
		unlisten?.();
		unDisconnect?.();
		transport?.disconnect();
		rejectPending();
		state.update((value) => ({
			...value,
			connected: false,
			session: {
				...value.session,
				unlocked: false,
				error: "Reconnecting to the service…",
			},
			media: {},
		}));
		clearTimeout(reconnect);
		reconnect = setTimeout(start, 250);
	}
	function receive(message) {
		if (disposed) return;
		lastMessage = Date.now();
		if (message.type === "snapshot") {
			for (const [id, job] of pending) {
				if (
					job.libraryId &&
					(!message.value.libraries?.[job.libraryId] ||
						(job.runtimeId &&
							job.runtimeId !==
								message.value.libraries[job.libraryId].runtimeId))
				) {
					pending.delete(id);
					job.reject(
						new Error(
							"Library context ended. The action may have completed; check its state before retrying.",
						),
					);
				}
			}
			connecting = false;
			const changed = instanceId && instanceId !== message.instanceId;
			if (changed) rejectPending();
			instanceId = message.instanceId;
			sequence = message.sequence;
			resyncing = false;
			state.set({
				...message.value,
				connected: true,
				instanceId,
				clientId: message.clientId,
			});
			resolveReady();
			return;
		}
		if (message.type === "fatal") {
			rejectReady(new Error(message.error));
			state.update((value) => ({
				...value,
				session: { ...value.session, ready: true, error: message.error },
			}));
			return;
		}
		if (message.instanceId !== instanceId || message.sequence <= sequence)
			return;
		if (message.sequence !== sequence + 1) {
			if (!resyncing) {
				resyncing = true;
				void command("snapshot").catch(() => {});
			}
			return;
		}
		sequence = message.sequence;
		if (message.type === "state")
			state.update((value) => {
				switch (message.topic) {
					case "library":
						return {
							...value,
							libraries: {
								...value.libraries,
								[message.value.id]: message.value.state,
							},
						};
					case "session":
						return { ...value, session: message.value };
					case "uploads":
						return { ...value, uploads: message.value };
					case "pairing":
						return { ...value, pairing: message.value };
					case "media":
						return {
							...value,
							media: { ...value.media, [message.value.id]: message.value },
						};
					case "mediaReset":
						return { ...value, media: {} };
					case "view":
						return {
							...value,
							views: { ...value.views, [message.value.id]: message.value },
						};
					default:
						return value;
				}
			});
		if (message.type === "reply") {
			const job = pending.get(message.requestId);
			if (!job) return;
			pending.delete(message.requestId);
			if (message.error) {
				const error = new Error(message.error.message);
				error.name = message.error.name;
				job.reject(error);
			} else job.resolve(message.value);
		}
		if (message.type === "helper") {
			const currentTransport = transport;
			Promise.resolve()
				.then(() => helper?.(message.name, message.payload))
				.catch(() => null)
				.then((value) => {
					if (!disposed && transport === currentTransport)
						transport.send({
							type: "helperResult",
							helperId: message.helperId,
							libraryId: message.libraryId,
							value: value ?? null,
						});
				});
		}
	}
	function start() {
		if (disposed || connecting) return;
		connecting = true;
		try {
			transport = connect();
			const currentTransport = transport;
			unlisten = transport.listen((message) => {
				if (transport === currentTransport) receive(message);
			});
			unDisconnect = transport.onDisconnect?.(lost);
			lastMessage = Date.now();
			transport.send({ type: "ping" });
		} catch (error) {
			connecting = false;
			rejectReady(error);
			state.update((value) => ({
				...value,
				session: { ...value.session, ready: true, error: error.message },
			}));
		}
	}
	async function command(name, payload = {}, { signal } = {}) {
		await ready;
		signal?.throwIfAborted();
		if (disposed || !get(state).connected)
			throw new Error("Service is disconnected. Try again.");
		const requestId = crypto.randomUUID();
		let rejectAbort;
		const result = new Promise((resolve, reject) => {
			pending.set(requestId, {
				resolve,
				reject,
				libraryId: name.startsWith("libraries.") ? null : payload.libraryId,
				runtimeId: get(state).libraries?.[payload.libraryId]?.runtimeId,
			});
			rejectAbort = reject;
		});
		const abort = () => {
			pending.delete(requestId);
			transport.send({
				type: "cancel",
				requestId,
				libraryId: payload.libraryId,
			});
			rejectAbort(signal.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			transport.send({
				type: "command",
				instanceId,
				requestId,
				name,
				payload: {
					...payload,
					runtimeId:
						payload.runtimeId ??
						get(state).libraries?.[payload.libraryId]?.runtimeId,
					epoch:
						payload.epoch ??
						(payload.libraryId
							? get(state).libraries[payload.libraryId]?.session.epoch
							: (get(state).session?.epoch ?? 0)),
				},
			});
			return await result;
		} catch (error) {
			pending.delete(requestId);
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	const resume = () => {
		hidden = false;
		if (get(state).connected) void command("snapshot").catch(() => {});
		else if (!disposed) {
			clearTimeout(reconnect);
			start();
		}
	};
	const heartbeat = setInterval(() => {
		if (disposed || hidden) return;
		if (Date.now() - lastMessage > 30_000) lost();
		else {
			try {
				transport?.send({ type: "ping" });
			} catch {
				lost();
			}
		}
	}, 5000);
	heartbeat.unref?.();
	const detach = () => {
		try {
			transport?.send({ type: "detach" });
		} catch {
			/* Already disconnected. */
		}
	};
	const pagehide = () => {
		hidden = true;
		connecting = false;
		detach();
		unlisten?.();
		unDisconnect?.();
		transport?.disconnect();
		rejectPending();
		state.update((value) => ({
			...value,
			connected: false,
			media: {},
			session: { ...value.session, unlocked: false },
		}));
	};
	browser?.addEventListener("pageshow", resume);
	browser?.addEventListener("focus", resume);
	browser?.addEventListener("pagehide", pagehide);
	start();
	return {
		subscribe: state.subscribe,
		ready,
		command,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearTimeout(reconnect);
			clearInterval(heartbeat);
			browser?.removeEventListener("pageshow", resume);
			browser?.removeEventListener("focus", resume);
			browser?.removeEventListener("pagehide", pagehide);
			detach();
			unlisten?.();
			unDisconnect?.();
			transport?.disconnect();
			rejectPending();
		},
	};
}
