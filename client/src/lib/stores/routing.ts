import { writable } from "svelte/store";

import { parseRoute, type Route, routeHref } from "../routes.ts";

export function createRouting(
	browser: Pick<
		Window,
		"location" | "history" | "addEventListener" | "removeEventListener"
	> = window,
) {
	let current = parseRoute(browser.location.hash);
	const state = writable(current);
	let disposed = false;
	function syncLocation() {
		const next = parseRoute(browser.location.hash);
		if (routeHref(next) !== routeHref(current)) {
			current = next;
			state.set(next);
		}
	}
	browser.addEventListener("hashchange", syncLocation);
	return {
		subscribe: state.subscribe,
		navigate(route: Route, replace = false) {
			if (disposed) {
				return;
			}
			const href = routeHref(route);
			if (href !== routeHref(parseRoute(browser.location.hash))) {
				if (replace) {
					browser.history.replaceState({}, "", href);
				} else {
					browser.location.hash = href;
				}
			}
			syncLocation();
		},
		dispose() {
			disposed = true;
			browser.removeEventListener("hashchange", syncLocation);
		},
	};
}
