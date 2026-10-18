import { writable } from "svelte/store";
import { createLog } from "../log.ts";

import { parseRoute, type Route, routeHref } from "../routes.ts";

export function createRouting(
	browser: Pick<
		Window,
		"location" | "history" | "addEventListener" | "removeEventListener"
	> = window,
) {
	const log = createLog("routing");
	let current = parseRoute(browser.location.hash);
	const state = writable(current);
	log.debug("initialized", { page: current.page });
	let disposed = false;
	function syncLocation() {
		const next = parseRoute(browser.location.hash);
		if (routeHref(next) !== routeHref(current)) {
			log.debug("changed", { from: current.page, to: next.page });
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
			log.debug("navigate", { page: route.page, replace });
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
			log.debug("disposed");
			disposed = true;
			browser.removeEventListener("hashchange", syncLocation);
		},
	};
}
