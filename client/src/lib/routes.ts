function defineRoute<
	const Page extends string,
	const Workspace extends boolean,
	Params extends Record<string, string>,
>(definition: {
	match: RegExp;
	page: Page;
	workspace: Workspace;
	params: (match: RegExpExecArray) => Params;
	href: (params: Params) => string;
}) {
	return {
		...definition,
		resolve(match: RegExpExecArray) {
			return {
				...definition.params(match),
				page: definition.page,
				workspace: definition.workspace,
			};
		},
	};
}

const routes = [
	defineRoute({
		match: /^#\/media(?:\/(.*))?$/s,
		page: "media",
		workspace: false,
		params: (match) => ({ id: match[1] ?? "" }),
		href: ({ id }) => `#/media/${id}`,
	}),
	defineRoute({
		match: /^#\/settings$/,
		page: "settings",
		workspace: true,
		params: () => ({}),
		href: () => "#/settings",
	}),
	defineRoute({
		match: /^#\/history$/,
		page: "history",
		workspace: true,
		params: () => ({}),
		href: () => "#/history",
	}),
	defineRoute({
		match: /.*/,
		page: "library",
		workspace: true,
		params: () => ({}),
		href: () => "#/library",
	}),
] as const;

type Definition = (typeof routes)[number];
export type Route = {
	[Page in Definition["page"]]: { page: Page } & ReturnType<
		Extract<Definition, { page: Page }>["params"]
	>;
}[Definition["page"]];
export type ResolvedRoute = ReturnType<Definition["resolve"]>;

export function parseRoute(hash: string): ResolvedRoute {
	for (const definition of routes) {
		const match = definition.match.exec(hash);
		if (match) {
			return definition.resolve(match);
		}
	}
	throw new Error("Route definitions must end with a catch-all.");
}

export function routeHref(route: Route): string {
	const definition = routes.find(
		(definition) => definition.page === route.page,
	);
	if (!definition) {
		throw new Error("Unknown route.");
	}
	// The page lookup selects the builder for this discriminated route's params.
	const href = definition.href as (params: Route) => string;
	return href(route);
}
