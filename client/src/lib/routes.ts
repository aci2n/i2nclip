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
