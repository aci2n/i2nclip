import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createTabAdmission } from "../src/lib/stores/tab.js";
import { tick } from "./helpers.js";

function world() {
	let held = false;
	const locks = {
		async request(name, options, callback) {
			assert.equal(name, "i2nclip-tab");
			assert.equal(options.ifAvailable, true);
			await Promise.resolve();
			if (held) {
				return callback(null);
			}
			held = true;
			try {
				return await callback({ name });
			} finally {
				held = false;
			}
		},
	};
	return () => {
		const browser = new EventTarget();
		browser.navigator = { locks };
		return browser;
	};
}

test("only one tab is admitted; explicit retry works after owner disposal", async (t) => {
	const browser = world();
	const first = createTabAdmission(browser());
	const second = createTabAdmission(browser());
	t.after(first.dispose);
	t.after(second.dispose);
	await tick();
	assert.equal(get(first).status, "active");
	assert.equal(get(second).status, "blocked");
	first.dispose();
	await tick();
	second.retry();
	await tick();
	assert.equal(get(second).status, "active");
});

test("pagehide releases admission and pageshow restores it only if still available", async (t) => {
	const browser = world();
	const owner = browser();
	const first = createTabAdmission(owner);
	t.after(first.dispose);
	await tick();
	owner.dispatchEvent(new Event("pagehide"));
	await tick();
	assert.equal(get(first).status, "suspended");
	const second = createTabAdmission(browser());
	t.after(second.dispose);
	await tick();
	const resume = new Event("pageshow");
	Object.defineProperty(resume, "persisted", { value: true });
	owner.dispatchEvent(resume);
	await tick();
	assert.equal(get(second).status, "active");
	assert.equal(get(first).status, "blocked");
});

test("disposed startup cannot acquire admission or publish an active state", async () => {
	const browser = world();
	const first = createTabAdmission(browser());
	first.dispose();
	await tick();
	assert.notEqual(get(first).status, "active");
	const second = createTabAdmission(browser());
	await tick();
	assert.equal(get(second).status, "active");
	second.dispose();
});

test("browsers without Web Locks fail before application initialization", () => {
	const browser = new EventTarget();
	browser.navigator = {};
	const admission = createTabAdmission(browser);
	assert.equal(get(admission).status, "unavailable");
	assert.match(get(admission).error, /Web Locks/);
	admission.dispose();
});
