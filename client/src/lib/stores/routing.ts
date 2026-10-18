import { writable } from "svelte/store";

import { parseRoute, type Route, routeHref } from "../routes.ts";

export function createRouting(
	browser: Pick<
		Window,
		"location" | "history" | "addEventListener" | "removeEventListener"
	> = window,
) {
	const state = writable(parseRoute(browser.location.search));
	let disposed = false;
	const popstate = () => state.set(parseRoute(browser.location.search));
	browser.addEventListener("popstate", popstate);
	return {
		subscribe: state.subscribe,
		navigate(route: Route, replace = false) {
			if (disposed) {
				return;
			}
			browser.history[replace ? "replaceState" : "pushState"](
				{},
				"",
				routeHref(route),
			);
			state.set(route);
		},
		dispose() {
			disposed = true;
			browser.removeEventListener("popstate", popstate);
		},
	};
}
