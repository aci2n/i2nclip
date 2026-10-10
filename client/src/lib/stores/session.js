import { get, writable } from "svelte/store";
import { registerKey } from "../api.js";
import { loadKey } from "../protocol/crypto.js";
import { generatePrivateKey } from "../protocol/identity.js";
import { parseRecoveryFile, recoveryFile } from "../protocol/recovery.js";
import { unwrapPrivateKey, wrapPrivateKey } from "../protocol/vault.js";

export const DEFAULT_SERVER_URL = "https://clip.i2n.duckdns.org";

function checkServer(serverUrl) {
	let url;
	try {
		url = new URL(serverUrl);
	} catch {
		throw new Error("Invalid server URL.");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("Invalid server URL.");
}

export function createSession(platform) {
	const state = writable({
		ready: false,
		serverUrl: DEFAULT_SERVER_URL,
		wrappedKey: null,
		privateKey: "",
		busy: false,
		error: "",
	});
	let revision = 0;
	let disposed = false;
	const controller = new AbortController();
	const active = () => controller.signal.throwIfAborted();

	async function refresh() {
		const version = ++revision;
		try {
			const [local, session] = await Promise.all([
				platform.local.get(["serverUrl", "wrappedKey", "publicKey"]),
				platform.session.get("privateKey"),
			]);
			let privateKey = "";
			if (local.wrappedKey && session.privateKey) {
				try {
					const loaded = await loadKey(session.privateKey);
					if (loaded.registrationKey === local.publicKey)
						privateKey = session.privateKey;
				} catch {
					/* A stale or damaged session must stay locked. */
				}
			}
			if (!disposed && version === revision)
				state.update((value) => ({
					...value,
					...local,
					ready: true,
					serverUrl: local.serverUrl || DEFAULT_SERVER_URL,
					wrappedKey: local.wrappedKey || null,
					privateKey,
					error: "",
				}));
		} catch (error) {
			if (!disposed && version === revision)
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
			const lock = globalThis.navigator?.locks;
			const guarded = async () => {
				await ready;
				active();
				await action();
				active();
			};
			await (lock
				? lock.request(
						"i2nclip-session",
						{ signal: controller.signal },
						guarded,
					)
				: guarded());
			await refresh();
			return true;
		} catch (error) {
			if (!disposed)
				state.update((value) => ({ ...value, error: error.message }));
			return false;
		} finally {
			if (!disposed) state.update((value) => ({ ...value, busy: false }));
		}
	}

	async function saveIdentity(serverUrl, privateKey, wrappedKey) {
		const loaded = await loadKey(privateKey);
		active();
		await platform.local.set({
			serverUrl,
			wrappedKey,
			publicKey: loaded.registrationKey,
		});
		active();
		await platform.session.set({ privateKey });
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
				const created = await generatePrivateKey();
				const wrapped = await wrapPrivateKey(created.privateKey, password);
				active();
				try {
					await registerKey({
						serverUrl,
						publicKey: created.publicKey,
						otc,
						signal: controller.signal,
					});
				} catch (error) {
					throw new Error(
						`${error.message === "registration failed" ? "Registration failed." : `Registration failed: ${error.message}.`} Check your invitation code and try again.`,
					);
				}
				await saveIdentity(serverUrl, created.privateKey, wrapped);
			}),
		restore: (file, password) =>
			mutate(async () => {
				if ((await platform.local.get("wrappedKey")).wrappedKey)
					throw new Error("A library is already configured.");
				if (!file || file.size > 16_384)
					throw new Error("Invalid recovery file.");
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
				const { wrappedKey } = await platform.local.get("wrappedKey");
				if (!wrappedKey)
					throw new Error("Create or restore your library in Settings.");
				const privateKey = await unwrapPrivateKey(wrappedKey, password);
				await loadKey(privateKey);
				active();
				await platform.session.set({ privateKey });
			}),
		setServer: (serverUrl) =>
			mutate(() => {
				checkServer(serverUrl);
				return platform.local.set({ serverUrl });
			}),
		reset: () =>
			mutate(async () => {
				await platform.session.clear();
				active();
				await platform.local.clear();
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
			const { serverUrl, privateKey } = get(state);
			if (!privateKey) throw new Error("Unlock before uploading.");
			return { serverUrl, privateKey };
		},
		dispose() {
			disposed = true;
			controller.abort();
			revision++;
			unsubscribe();
		},
	};
}
