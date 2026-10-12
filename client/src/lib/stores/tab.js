import { writable } from "svelte/store";

// The only cross-tab coordination: admission before any saved state is read.
export function createTabAdmission(browser = window) {
	const state = writable({ status: "checking", error: "" });
	let release;
	let revision = 0;
	let disposed = false;
	let pending = false;
	function leave() {
		revision++;
		pending = false;
		release?.();
		release = null;
		if (!disposed) {
			state.set({ status: "suspended", error: "" });
		}
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
					await new Promise((resolve) => {
						release = resolve;
						state.set({ status: "active", error: "" });
					});
				},
			)
			.catch((error) => {
				if (!disposed && own === revision) {
					pending = false;
					state.set({ status: "unavailable", error: error.message });
				}
			});
	}
	const resume = (event) => {
		if (event.persisted) {
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
