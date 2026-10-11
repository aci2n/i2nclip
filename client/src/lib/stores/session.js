import { get, writable } from "svelte/store";
import { isKeyRegistered, registerKey } from "../api.js";
import { loadKey } from "../protocol/crypto.js";
import { generatePrivateKey } from "../protocol/identity.js";
import { parseRecoveryFile, recoveryFile } from "../protocol/recovery.js";
import { checkServer, DEFAULT_SERVER_URL } from "../protocol/server.js";
import { unwrapPrivateKey, wrapPrivateKey } from "../protocol/vault.js";
import { createSessionContext } from "./session-context.js";
import { createSessionStorage } from "./session-storage.js";

export { DEFAULT_SERVER_URL } from "../protocol/server.js";

export function createSession(platform) {
	const defaultServerUrl =
		platform.defaultServerUrl ||
		(["http:", "https:"].includes(globalThis.location?.protocol)
			? globalThis.location.origin
			: DEFAULT_SERVER_URL);
	const state = writable({
		ready: false,
		serverUrl: defaultServerUrl,
		wrappedKey: null,
		pendingRegistration: null,
		identityGeneration: null,
		privateKey: "",
		publicKey: "",
		busy: false,
		error: "",
	});
	let disposed = false;
	const controller = new AbortController();
	const active = () => controller.signal.throwIfAborted();
	const storage = createSessionStorage(platform, controller.signal);
	const context = createSessionContext(state);

	function publish(snapshot) {
		state.update((value) => ({
			...value,
			...snapshot,
			ready: true,
			error: "",
		}));
	}

	async function readIdentity(tx) {
		const [local, session] = await Promise.all([
			tx.local.get([
				"serverUrl",
				"wrappedKey",
				"publicKey",
				"identityGeneration",
				"pendingRegistration",
			]),
			tx.session.get(["privateKey", "sessionGeneration"]),
		]);
		let privateKey = "";
		if (
			local.wrappedKey &&
			session.privateKey &&
			typeof local.identityGeneration === "string" &&
			local.identityGeneration &&
			session.sessionGeneration === local.identityGeneration
		) {
			try {
				const loaded = await loadKey(session.privateKey);
				if (loaded.registrationKey === local.publicKey)
					privateKey = session.privateKey;
			} catch {
				/* A stale or damaged session must stay locked. */
			}
		}
		active();
		// Reads and cleanup share the mutation lock: a queued refresh cannot
		// remove a key written by a later unlock using an earlier snapshot.
		if (!privateKey && (session.privateKey || session.sessionGeneration)) {
			await tx.session.remove(["privateKey", "sessionGeneration"]);
			active();
		}
		return {
			...local,
			privateKey,
			publicKey: local.publicKey || "",
			serverUrl:
				local.pendingRegistration?.serverUrl ||
				local.serverUrl ||
				defaultServerUrl,
			wrappedKey: local.wrappedKey || null,
			pendingRegistration: local.pendingRegistration || null,
			identityGeneration: local.identityGeneration || null,
		};
	}

	async function refresh() {
		try {
			await storage.transaction(async (tx) => {
				active();
				const snapshot = await readIdentity(tx);
				publish(snapshot);
			});
		} catch (error) {
			if (!disposed)
				state.update((value) => ({
					...value,
					ready: true,
					privateKey: "",
					error: error.message,
				}));
		}
	}
	const unsubscribe = platform.subscribe(refresh);
	const ready = refresh();

	async function mutate(
		action,
		{ changesIdentity = true, operationOptions } = {},
	) {
		if (get(state).busy || disposed) return false;
		state.update((value) => ({
			...value,
			busy: true,
			error: "",
			...(changesIdentity ? { privateKey: "" } : {}),
		}));
		if (changesIdentity) context.invalidate();
		try {
			// One settings mutation across all open pages, including password derivation.
			// Initial refresh also acquires this lock; await it before queueing.
			await ready;
			let result = true;
			await storage.transaction(async (tx) => {
				active();
				const identity = await readIdentity(tx);
				await action(tx, identity);
				active();
				const snapshot = await readIdentity(tx);
				publish(snapshot);
				if (operationOptions) result = context.operation(operationOptions);
			});
			return result;
		} catch (error) {
			if (!disposed) {
				await refresh();
				state.update((value) => ({ ...value, error: error.message }));
			}
			return false;
		} finally {
			if (!disposed) state.update((value) => ({ ...value, busy: false }));
		}
	}

	async function saveIdentity(tx, serverUrl, privateKey, wrappedKey, signal) {
		const loaded = await loadKey(privateKey);
		const identityGeneration = crypto.randomUUID();
		active();
		signal?.throwIfAborted();
		await tx.local.set({
			serverUrl,
			wrappedKey,
			publicKey: loaded.registrationKey,
			identityGeneration,
			pendingRegistration: null,
		});
		active();
		await tx.session.set({
			privateKey,
			sessionGeneration: identityGeneration,
		});
	}

	return {
		subscribe: state.subscribe,
		ready,
		refresh,
		observeIdentity: context.observe,
		operation(options) {
			active();
			return context.operation(options);
		},
		async withIdentity(operation, action) {
			if (!context.owns(operation))
				throw new Error("Invalid session operation.");
			await ready;
			operation.signal.throwIfAborted();
			return storage.transaction(async (tx) => {
				const snapshot = await readIdentity(tx);
				operation.signal.throwIfAborted();
				// A missed storage event must update the render snapshot too, so
				// owners can dispose stale work and start again with the new identity.
				if (!context.matches(get(state), snapshot)) publish(snapshot);
				if (
					!context.matches(context.expected(operation), snapshot) ||
					!snapshot.privateKey
				) {
					operation.abort(
						new DOMException("Library changed. Try again.", "AbortError"),
					);
					throw new Error("Library or server changed. Start again.");
				}
				operation.signal.throwIfAborted();
				return action(
					Object.freeze({
						serverUrl: snapshot.serverUrl,
						privateKey: snapshot.privateKey,
						publicKey: snapshot.publicKey,
						identityGeneration: snapshot.identityGeneration,
					}),
				);
			}, operation.signal);
		},
		pending: Object.freeze({
			get: (id) =>
				storage.transaction(
					async (tx) => (await tx.session.get(`upload:${id}`))[`upload:${id}`],
				),
			put: (id, value) =>
				storage.transaction((tx) =>
					tx.session.set({ [`upload:${id}`]: value }),
				),
			remove: (id) =>
				storage.transaction((tx) => tx.session.remove(`upload:${id}`)),
			fail: (id, error) =>
				storage.transaction(async (tx) => {
					const key = `upload:${id}`;
					const stored = (await tx.session.get(key))[key];
					if (!stored) return false;
					await tx.session.set({ [key]: { ...stored, error } });
					return true;
				}),
		}),
		importPairing: ({
			serverUrl,
			privateKey,
			publicKey,
			password,
			signal,
			onInvalidated,
		}) =>
			mutate(
				async (tx, identity) => {
					signal.throwIfAborted();
					checkServer(serverUrl);
					if (identity.wrappedKey || identity.pendingRegistration)
						throw new Error(
							"A library or pending creation is already configured.",
						);
					if (password.length < 8)
						throw new Error("Password must be at least 8 characters.");
					if ((await loadKey(privateKey)).registrationKey !== publicKey)
						throw new Error("Invalid paired identity.");
					const wrappedKey = await wrapPrivateKey(privateKey, password);
					signal.throwIfAborted();
					await saveIdentity(tx, serverUrl, privateKey, wrappedKey, signal);
				},
				{ operationOptions: { signal, onInvalidated } },
			),
		create: ({ serverUrl, password, otc }) =>
			mutate(async (tx, identity) => {
				checkServer(serverUrl);
				if (identity.wrappedKey)
					throw new Error("A library is already configured.");
				if (password.length < 8)
					throw new Error("Password must be at least 8 characters.");
				if (!otc.trim())
					throw new Error("Enter an invitation code from the admin.");
				let { pendingRegistration: pending } = identity;
				const retry = Boolean(pending);
				let privateKey;
				if (pending) {
					if (pending.serverUrl !== serverUrl)
						throw new Error(
							"Retry creation on its original server, or discard the pending creation first.",
						);
					privateKey = await unwrapPrivateKey(pending.wrappedKey, password);
					if ((await loadKey(privateKey)).registrationKey !== pending.publicKey)
						throw new Error("Invalid pending identity.");
				} else {
					const created = await generatePrivateKey();
					privateKey = created.privateKey;
					pending = {
						serverUrl,
						publicKey: created.publicKey,
						wrappedKey: await wrapPrivateKey(privateKey, password),
					};
					active();
					// Never send registration until the encrypted identity is durable.
					await tx.local.set({ pendingRegistration: pending });
				}
				active();
				try {
					// On retry this also recovers a successful registration with a lost response.
					if (
						!retry ||
						!(await isKeyRegistered({
							serverUrl,
							privateKey,
							signal: controller.signal,
						}))
					) {
						await registerKey({
							serverUrl,
							publicKey: pending.publicKey,
							otc,
							signal: controller.signal,
						});
					}
				} catch (error) {
					throw new Error(
						`${error.message === "registration failed" ? "Registration failed." : `Registration failed: ${error.message}.`} Your encrypted identity is saved. Check your invitation code and retry with the original password.`,
					);
				}
				await saveIdentity(tx, serverUrl, privateKey, pending.wrappedKey);
			}),
		restore: (file, password) =>
			mutate(async (tx, identity) => {
				if (identity.wrappedKey)
					throw new Error("A library is already configured.");
				if (!file || file.size > 16_384)
					throw new Error("Invalid recovery file.");
				if (identity.pendingRegistration)
					throw new Error(
						"Finish or discard the pending creation before restoring a library.",
					);
				const recovered = parseRecoveryFile(await file.text());
				const privateKey = await unwrapPrivateKey(
					recovered.wrappedKey,
					password,
				);
				await saveIdentity(
					tx,
					recovered.serverUrl,
					privateKey,
					recovered.wrappedKey,
				);
			}),
		unlock: (password) =>
			mutate(async (tx, identity) => {
				const { wrappedKey, identityGeneration } = identity;
				if (!wrappedKey)
					throw new Error("Create or restore your library in Settings.");
				const privateKey = await unwrapPrivateKey(wrappedKey, password);
				await loadKey(privateKey);
				active();
				const generation =
					typeof identityGeneration === "string" && identityGeneration
						? identityGeneration
						: crypto.randomUUID();
				if (generation !== identityGeneration) {
					await tx.local.set({ identityGeneration: generation });
					active();
				}
				await tx.session.set({
					privateKey,
					sessionGeneration: generation,
				});
			}),
		setServer: (serverUrl) =>
			mutate(async (tx, identity) => {
				checkServer(serverUrl);
				if (identity.pendingRegistration)
					throw new Error(
						"Finish or discard the pending creation before changing servers.",
					);
				return tx.local.set({ serverUrl });
			}),
		discardCreation: () =>
			mutate(async (tx) => {
				await tx.local.remove("pendingRegistration");
			}),
		reset: () =>
			mutate(async (tx) => {
				await tx.local.clear();
				active();
				await tx.session.clear();
			}),
		backup: () =>
			mutate(
				async (_tx, identity) => {
					const file = recoveryFile(identity);
					active();
					const url = URL.createObjectURL(
						new Blob([file], { type: "application/json" }),
					);
					try {
						await platform.download(url, "i2nclip-recovery.json");
					} finally {
						setTimeout(() => URL.revokeObjectURL(url), 60_000);
					}
				},
				{ changesIdentity: false },
			),

		dispose() {
			disposed = true;
			context.invalidate();
			controller.abort();
			unsubscribe();
		},
	};
}
