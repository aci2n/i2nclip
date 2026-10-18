export type Route =
	| { page: "library" | "settings" }
	| { page: "media"; id: string };

export function parseRoute(hash: string): Route {
	if (hash === "#/settings") {
		return { page: "settings" };
	}
	if (hash === "#/media" || hash.startsWith("#/media/")) {
		return { page: "media", id: hash.slice("#/media/".length) };
	}
	return { page: "library" };
}

export function routeHref(route: Route): string {
	return route.page === "media" ? `#/media/${route.id}` : `#/${route.page}`;
}
