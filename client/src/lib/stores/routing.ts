import { writable } from "svelte/store";

export type Route =
	| { page: "library" | "settings" }
	| { page: "media"; id: string };

export function parseRoute(search: string): Route {
	const params = new URLSearchParams(search);
	switch (params.get("page")) {
		case "media":
			return { page: "media", id: params.get("id") || "" };
		case "settings":
			return { page: "settings" };
		default:
			return { page: "library" };
	}
}

export function routeHref(route: Route): string {
	const params = new URLSearchParams({ page: route.page });
	if (route.page === "media") {
		params.set("id", route.id);
	}
	return `?${params}`;
}

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
