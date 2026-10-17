import { writable } from "svelte/store";
import { errorMessage } from "../error.ts";
export interface TabBrowser {
	addEventListener(type: string, listener: (event: Event) => void): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
	navigator: {
		locks?: {
			request(
				name: string,
				options: { mode: "exclusive"; ifAvailable: true },
				callback: (lock: { name: string } | null) => Promise<void>,
			): Promise<void>;
		};
	};
}

// The only cross-tab coordination: admission before any saved state is read.
export function createTabAdmission(browser: TabBrowser = window) {
	const state = writable({ status: "checking", error: "" });
	let release: (() => void) | null = null;
	let revision = 0;
	let disposed = false;
	let pending = false;
	function leave() {
		revision++;
		pending = false;
		const unlock = release;
		release = null;
		if (!disposed) {
			state.set({ status: "suspended", error: "" });
		}
		// Let the root view dispose its workflows before another tab enters.
		queueMicrotask(() => unlock?.());
	}
	function acquire() {
		if (disposed || pending || release) {
			return;
		}
		const locks = browser.navigator.locks;
		if (!locks) {
			state.set({
				status: "unavailable",
				error:
					"This browser cannot enforce single-tab access. Use a browser with Web Locks support.",
			});
			return;
		}
		pending = true;
		const own = ++revision;
		state.set({ status: "checking", error: "" });
		void locks
			.request(
				"i2nclip-tab",
				{ mode: "exclusive", ifAvailable: true },
				async (lock) => {
					if (disposed || own !== revision) {
						return;
					}
					pending = false;
					if (!lock) {
						state.set({
							status: "blocked",
							error:
								"i2nclip is already open in another tab. Close it, then retry here.",
						});
						return;
					}
					await new Promise<void>((resolve) => {
						release = resolve;
						state.set({ status: "active", error: "" });
					});
				},
			)
			.catch((error) => {
				if (!disposed && own === revision) {
					pending = false;
					state.set({ status: "unavailable", error: errorMessage(error) });
				}
			});
	}
	const resume = (event: Event) => {
		if ("persisted" in event && event.persisted) {
			acquire();
		}
	};
	browser.addEventListener("pagehide", leave);
	browser.addEventListener("pageshow", resume);
	acquire();
	return {
		subscribe: state.subscribe,
		retry: acquire,
		dispose() {
			disposed = true;
			leave();
			browser.removeEventListener("pagehide", leave);
			browser.removeEventListener("pageshow", resume);
		},
	};
}
