import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { parseRoute, routeHref } from "../src/lib/routes.ts";
import { createRouting } from "../src/lib/stores/routing.ts";
import { captureLogs } from "./log-capture.ts";

test("hash routes format links and preserve malformed media targets for local validation", () => {
	for (const hash of [
		"",
		"#",
		"#/library",
		"#/unknown",
		"#/settings/extra",
		"#/media-other",
		"?page=settings",
	]) {
		assert.deepEqual(parseRoute(hash), { page: "library", workspace: true });
	}
	assert.deepEqual(parseRoute("#/settings"), {
		page: "settings",
		workspace: true,
	});
	for (const id of ["", "bad", "a".repeat(64), "a/extra", "%zz", "a\nb"]) {
		const route = { page: "media" as const, id };
		assert.deepEqual(parseRoute(routeHref(route)), {
			...route,
			workspace: false,
		});
	}
	assert.equal(routeHref({ page: "library" }), "#/library");
	assert.equal(routeHref({ page: "settings" }), "#/settings");
	assert.equal(
		routeHref({ page: "media", id: "a".repeat(64) }),
		`#/media/${"a".repeat(64)}`,
	);
	assert.deepEqual(parseRoute("#/media"), {
		page: "media",
		id: "",
		workspace: false,
	});
});

function fixture(t: test.TestContext, initial = "#/settings") {
	const events = new EventTarget();
	let hash = initial;
	const writes: [string, string][] = [];
	const location = {
		get hash() {
			return hash;
		},
		set hash(value: string) {
			hash = value;
			writes.push(["push", value]);
		},
	};
	const routing = createRouting({
		location: location as Location,
		history: {
			replaceState(_data, _unused, url) {
				hash = String(url);
				writes.push(["replace", hash]);
			},
		} as History,
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	});
	t.after(routing.dispose);
	const seen: unknown[] = [];
	const unsubscribe = routing.subscribe((route) => seen.push(route));
	t.after(unsubscribe);
	return {
		routing,
		writes,
		seen,
		change(value: string) {
			hash = value;
		},
		notify() {
			events.dispatchEvent(new Event("hashchange"));
		},
	};
}

test("programmatic navigation publishes synchronously and distinguishes push from replacement", (t) => {
	const f = fixture(t);
	assert.deepEqual(get(f.routing), { page: "settings", workspace: true });
	f.routing.navigate({ page: "library" });
	assert.deepEqual(get(f.routing), { page: "library", workspace: true });
	f.routing.navigate({ page: "settings" }, true);
	assert.deepEqual(get(f.routing), { page: "settings", workspace: true });
	assert.deepEqual(f.writes, [
		["push", "#/library"],
		["replace", "#/settings"],
	]);
	f.notify();
	assert.equal(f.seen.length, 3);
	f.routing.navigate({ page: "settings" });
	f.routing.navigate({ page: "settings" }, true);
	assert.equal(f.writes.length, 2);
	assert.equal(f.seen.length, 3);
});

test("native hash navigation reads current location and ignores duplicate or queued stale events", (t) => {
	const logs = captureLogs(t);
	const f = fixture(t);
	f.change("#/media/bad");
	f.notify();
	assert.deepEqual(get(f.routing), {
		page: "media",
		id: "bad",
		workspace: false,
	});
	f.change("#/media/another");
	f.notify();
	assert.deepEqual(get(f.routing), {
		page: "media",
		id: "another",
		workspace: false,
	});
	f.change("#/library");
	f.notify();
	f.notify();
	assert.deepEqual(get(f.routing), { page: "library", workspace: true });
	assert.equal(f.seen.length, 4);
	// Navigation can happen before the preceding native hashchange is delivered.
	f.change("#/settings");
	f.routing.navigate({ page: "settings" });
	assert.deepEqual(get(f.routing), { page: "settings", workspace: true });
	assert.equal(f.writes.length, 0);
	f.notify();
	assert.equal(f.seen.length, 5);
	const changes = logs.filter(
		(entry) => entry.event === "[i2nclip] routing.changed",
	);
	assert.equal(changes.length, 4);
	assert(changes.every((entry) => entry.level === "debug"));
	const output = JSON.stringify(logs);
	for (const target of ["bad", "another", "#/media"]) {
		assert(!output.includes(target));
	}
});

test("an empty hash is Library and repeated navigation does not add history", (t) => {
	const f = fixture(t, "");
	f.routing.navigate({ page: "library" });
	assert.deepEqual(f.writes, []);
	assert.deepEqual(get(f.routing), { page: "library", workspace: true });
});

test("disposal removes the hash listener and disables navigation", (t) => {
	const f = fixture(t);
	f.routing.dispose();
	f.change("#/library");
	f.notify();
	f.routing.navigate({ page: "media", id: "bad" });
	assert.deepEqual(get(f.routing), { page: "settings", workspace: true });
	assert.equal(f.writes.length, 0);
	assert.equal(f.seen.length, 1);
});
