import { writable } from "svelte/store";
import { createLog } from "../log.ts";

import {
	parseRoute,
	type ResolvedRoute,
	type Route,
	routeHref,
} from "../routes.ts";

type RoutingBrowser = Pick<
	Window,
	"location" | "history" | "addEventListener" | "removeEventListener"
>;
interface RoutingDependencies {
	browser: RoutingBrowser;
	log: ReturnType<typeof createLog>;
}
interface RoutingRuntime {
	current: ResolvedRoute;
	state: ReturnType<typeof writable<ResolvedRoute>>;
	disposed: boolean;
	syncLocation: () => void;
}

export function createRouting(
	browser: Pick<
		Window,
		"location" | "history" | "addEventListener" | "removeEventListener"
	> = window,
) {
	const deps: RoutingDependencies = { browser, log: createLog("routing") };
	const current = parseRoute(browser.location.hash);
	const runtime: RoutingRuntime = {
		current,
		state: writable(current),
		disposed: false,
		syncLocation: () => syncLocation(deps, runtime),
	};
	deps.log.debug("initialized", { page: current.page });
	browser.addEventListener("hashchange", runtime.syncLocation);

	return {
		subscribe: runtime.state.subscribe,
		navigate: navigate.bind(null, deps, runtime),
		dispose: disposeRouting.bind(null, deps, runtime),
	};
}

function syncLocation(deps: RoutingDependencies, runtime: RoutingRuntime) {
	const next = parseRoute(deps.browser.location.hash);
	if (routeHref(next) !== routeHref(runtime.current)) {
		deps.log.debug("changed", { from: runtime.current.page, to: next.page });
		runtime.current = next;
		runtime.state.set(next);
	}
}

function navigate(
	deps: RoutingDependencies,
	runtime: RoutingRuntime,
	route: Route,
	replace = false,
) {
	if (runtime.disposed) {
		return;
	}
	deps.log.debug("navigate", { page: route.page, replace });
	const href = routeHref(route);
	if (href !== routeHref(parseRoute(deps.browser.location.hash))) {
		if (replace) {
			deps.browser.history.replaceState({}, "", href);
		} else {
			deps.browser.location.hash = href;
		}
	}
	syncLocation(deps, runtime);
}

function disposeRouting(deps: RoutingDependencies, runtime: RoutingRuntime) {
	deps.log.debug("disposed");
	runtime.disposed = true;
	deps.browser.removeEventListener("hashchange", runtime.syncLocation);
}
