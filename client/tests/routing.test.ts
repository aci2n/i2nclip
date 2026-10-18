import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { parseRoute, routeHref } from "../src/lib/routes.ts";
import { createRouting } from "../src/lib/stores/routing.ts";

test("routes preserve query links and invalid media targets", () => {
	for (const search of ["", "?page=unknown", "?id=unused"]) {
		assert.deepEqual(parseRoute(search), { page: "library" });
	}
	assert.deepEqual(parseRoute("?page=settings&id=unused"), {
		page: "settings",
	});
	for (const id of ["", "bad", "a".repeat(64), "a &?#"]) {
		const route = { page: "media" as const, id };
		assert.deepEqual(parseRoute(routeHref(route)), route);
	}
	assert.equal(routeHref({ page: "library" }), "?page=library");
	assert.equal(routeHref({ page: "settings" }), "?page=settings");
	assert.equal(
		routeHref({ page: "media", id: "a".repeat(64) }),
		`?page=media&id=${"a".repeat(64)}`,
	);
	assert.deepEqual(parseRoute("?page=media"), { page: "media", id: "" });
});

test("navigation publishes immediately, distinguishes push/replace and follows history until disposal", (t) => {
	const events = new EventTarget();
	const location = { search: "?page=settings" };
	const writes: [string, string | URL | null | undefined][] = [];
	const routing = createRouting({
		location: location as Location,
		history: {
			pushState(_data, _unused, url) {
				writes.push(["push", url]);
			},
			replaceState(_data, _unused, url) {
				writes.push(["replace", url]);
			},
		} as History,
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	});
	t.after(() => routing.dispose());
	assert.deepEqual(get(routing), { page: "settings" });
	routing.navigate({ page: "library" });
	assert.deepEqual(get(routing), { page: "library" });
	routing.navigate({ page: "settings" }, true);
	assert.deepEqual(get(routing), { page: "settings" });
	assert.deepEqual(writes, [
		["push", "?page=library"],
		["replace", "?page=settings"],
	]);
	location.search = "?page=media&id=bad";
	events.dispatchEvent(new Event("popstate"));
	assert.deepEqual(get(routing), { page: "media", id: "bad" });
	location.search = "?page=library";
	events.dispatchEvent(new Event("popstate"));
	assert.deepEqual(get(routing), { page: "library" });
	routing.dispose();
	location.search = "?page=settings";
	events.dispatchEvent(new Event("popstate"));
	routing.navigate({ page: "settings" });
	assert.deepEqual(get(routing), { page: "library" });
	assert.equal(writes.length, 2);
});
