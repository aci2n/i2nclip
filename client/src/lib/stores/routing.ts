import { type Writable, writable } from "svelte/store";
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
export function createRouting(
	browser: Pick<
		Window,
		"location" | "history" | "addEventListener" | "removeEventListener"
	> = window,
): Pick<RoutingStoreImpl, keyof RoutingStoreImpl> {
	return new RoutingStoreImpl(browser);
}

class RoutingStoreImpl {
	private readonly browser: RoutingBrowser;
	private readonly log: ReturnType<typeof createLog>;
	private current: ResolvedRoute;
	private readonly state: Writable<ResolvedRoute>;
	private disposed: boolean;
	private syncLocation: () => void;

	readonly subscribe: Writable<ResolvedRoute>["subscribe"];
	readonly navigate = this.navigateRoute.bind(this);
	readonly dispose = this.disposeRouting.bind(this);

	constructor(
		browser: Pick<
			Window,
			"location" | "history" | "addEventListener" | "removeEventListener"
		> = window,
	) {
		this.browser = browser;
		this.log = createLog("routing");
		const current = parseRoute(browser.location.hash);
		this.current = current;
		this.state = writable(current);
		this.subscribe = this.state.subscribe;
		this.disposed = false;
		this.syncLocation = this.syncRoute.bind(this);
		this.log.debug("initialized", { page: current.page });
		browser.addEventListener("hashchange", this.syncLocation);
	}

	private syncRoute() {
		const next = parseRoute(this.browser.location.hash);
		if (routeHref(next) !== routeHref(this.current)) {
			this.log.debug("changed", { from: this.current.page, to: next.page });
			this.current = next;
			this.state.set(next);
		}
	}

	private navigateRoute(route: Route, replace = false) {
		if (this.disposed) {
			return;
		}
		this.log.debug("navigate", { page: route.page, replace });
		const href = routeHref(route);
		if (href !== routeHref(parseRoute(this.browser.location.hash))) {
			if (replace) {
				this.browser.history.replaceState({}, "", href);
			} else {
				this.browser.location.hash = href;
			}
		}
		this.syncRoute();
	}

	private disposeRouting() {
		this.log.debug("disposed");
		this.disposed = true;
		this.browser.removeEventListener("hashchange", this.syncLocation);
	}
}
