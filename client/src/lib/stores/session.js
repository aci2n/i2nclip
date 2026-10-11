import { get, writable } from "svelte/store";
import { isKeyRegistered, registerKey } from "../api.js";
import { loadKey } from "../protocol/crypto.js";
import { generatePrivateKey } from "../protocol/identity.js";
import { parseRecoveryFile, recoveryFile } from "../protocol/recovery.js";
import { checkServer } from "../protocol/server.js";
import { unwrapPrivateKey, wrapPrivateKey } from "../protocol/vault.js";

export const DEFAULT_SERVER_URL = "https://clip.i2n.duckdns.org";

export function createSession(platform) {
	const state = writable({
		ready: false,
		serverUrl: DEFAULT_SERVER_URL,
		wrappedKey: null,
		pendingRegistration: null,
		identityGeneration: null,
		privateKey: "",
		busy: false,
		error: "",
	});
	let disposed = false;
	const controller = new AbortController();
	const active = () => controller.signal.throwIfAborted();
	const coordinated = (action) => {
		const locks = globalThis.navigator?.locks;
		if (!locks)
			throw new Error("Session coordination is unavailable. Try again.");
		return locks.request(
			"i2nclip-session",
			{ signal: controller.signal },
			action,
		);
	};

	async function refresh() {
		try {
			await coordinated(async () => {
				active();
				const [local, session] = await Promise.all([
					platform.local.get([
						"serverUrl",
						"wrappedKey",
						"publicKey",
						"identityGeneration",
						"pendingRegistration",
					]),
					platform.session.get(["privateKey", "sessionGeneration"]),
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
					await platform.session.remove(["privateKey", "sessionGeneration"]);
					active();
				}
				state.update((value) => ({
					...value,
					...local,
					ready: true,
					serverUrl: local.wrappedKey
						? local.serverUrl || DEFAULT_SERVER_URL
						: local.pendingRegistration?.serverUrl ||
							local.serverUrl ||
							DEFAULT_SERVER_URL,
					pendingRegistration: local.pendingRegistration || null,
					wrappedKey: local.wrappedKey || null,
					identityGeneration: local.identityGeneration || null,
					privateKey,
					error: "",
				}));
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

	async function mutate(action) {
		if (get(state).busy || disposed) return false;
		state.update((value) => ({ ...value, busy: true, error: "" }));
		try {
			// One settings mutation across all open pages, including password derivation.
			// Initial refresh also acquires this lock; await it before queueing.
			await ready;
			await coordinated(async () => {
				active();
				await action();
				active();
			});
			await refresh();
			return true;
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

	async function saveIdentity(serverUrl, privateKey, wrappedKey) {
		const loaded = await loadKey(privateKey);
		const identityGeneration = crypto.randomUUID();
		active();
		await platform.local.set({
			serverUrl,
			wrappedKey,
			publicKey: loaded.registrationKey,
			identityGeneration,
			pendingRegistration: null,
		});
		active();
		await platform.session.set({
			privateKey,
			sessionGeneration: identityGeneration,
		});
	}

	return {
		subscribe: state.subscribe,
		ready,
		refresh,
		create: ({ serverUrl, password, otc }) =>
			mutate(async () => {
				checkServer(serverUrl);
				if ((await platform.local.get("wrappedKey")).wrappedKey)
					throw new Error("A library is already configured.");
				if (password.length < 8)
					throw new Error("Password must be at least 8 characters.");
				if (!otc.trim())
					throw new Error("Enter an invitation code from the admin.");
				let { pendingRegistration: pending } = await platform.local.get(
					"pendingRegistration",
				);
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
					await platform.local.set({ pendingRegistration: pending });
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
				await saveIdentity(serverUrl, privateKey, pending.wrappedKey);
			}),
		restore: (file, password) =>
			mutate(async () => {
				if ((await platform.local.get("wrappedKey")).wrappedKey)
					throw new Error("A library is already configured.");
				if (!file || file.size > 16_384)
					throw new Error("Invalid recovery file.");
				if (
					(await platform.local.get("pendingRegistration")).pendingRegistration
				)
					throw new Error(
						"Finish or discard the pending creation before restoring a library.",
					);
				const recovered = parseRecoveryFile(await file.text());
				const privateKey = await unwrapPrivateKey(
					recovered.wrappedKey,
					password,
				);
				await saveIdentity(
					recovered.serverUrl,
					privateKey,
					recovered.wrappedKey,
				);
			}),
		unlock: (password) =>
			mutate(async () => {
				const { wrappedKey, identityGeneration } = await platform.local.get([
					"wrappedKey",
					"identityGeneration",
				]);
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
					await platform.local.set({ identityGeneration: generation });
					active();
				}
				await platform.session.set({
					privateKey,
					sessionGeneration: generation,
				});
			}),
		setServer: (serverUrl) =>
			mutate(async () => {
				checkServer(serverUrl);
				if (
					(await platform.local.get("pendingRegistration")).pendingRegistration
				)
					throw new Error(
						"Finish or discard the pending creation before changing servers.",
					);
				return platform.local.set({ serverUrl });
			}),
		discardCreation: () =>
			mutate(async () => {
				await platform.local.remove("pendingRegistration");
			}),
		reset: () =>
			mutate(async () => {
				await platform.local.clear();
				active();
				await platform.session.clear();
			}),
		backup: () =>
			mutate(async () => {
				const file = recoveryFile(
					await platform.local.get(["serverUrl", "wrappedKey", "publicKey"]),
				);
				active();
				const url = URL.createObjectURL(
					new Blob([file], { type: "application/json" }),
				);
				try {
					await platform.download(url, "i2nclip-recovery.json");
				} finally {
					setTimeout(() => URL.revokeObjectURL(url), 60_000);
				}
			}),
		credentials() {
			active();
			const { serverUrl, privateKey, identityGeneration } = get(state);
			if (!privateKey) throw new Error("Unlock before uploading.");
			return { serverUrl, privateKey, identityGeneration };
		},
		dispose() {
			disposed = true;
			controller.abort();
			unsubscribe();
		},
	};
}
