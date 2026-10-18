// Checked by the client TypeScript check; intentionally not a runtime test.
import { type ResolvedRoute, routeHref } from "../src/lib/routes.ts";
import type { createRouting } from "../src/lib/stores/routing.ts";

export function checkRouteTypes(
	route: ResolvedRoute,
	routing: ReturnType<typeof createRouting>,
) {
	routing.navigate({ page: "library" });
	routing.navigate({ page: "media", id: "a".repeat(64) }, true);
	// @ts-expect-error Programmatic Media navigation also requires an ID.
	routing.navigate({ page: "media" });
	routeHref({ page: "library" });
	routeHref({ page: "settings" });
	routeHref({ page: "media", id: "a".repeat(64) });
	// @ts-expect-error Media requires an ID.
	routeHref({ page: "media" });
	// @ts-expect-error IDs must be strings.
	routeHref({ page: "media", id: 1 });
	// @ts-expect-error Unknown pages are not navigation targets.
	routeHref({ page: "unknown" });
	// @ts-expect-error Static routes have no ID parameter.
	routeHref({ page: "settings", id: "unused" });
	// @ts-expect-error Static routes have no ID parameter.
	routeHref({ page: "library", id: "unused" });
	// @ts-expect-error Workspace metadata is resolved, not supplied by callers.
	routeHref({ page: "library", workspace: true });

	if (route.page === "media") {
		const media: { id: string; workspace: false } = route;
		return media;
	}
	const browsing: { page: "library" | "settings"; workspace: true } = route;
	return browsing;
}
