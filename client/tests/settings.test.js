import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { createSettings } from "../src/lib/stores/settings.js";
import { deferred } from "./helpers.js";

test("settings retain failed form input and serialize feedback until an action settles", async () => {
	const state = writable({
		serverUrl: "https://clip.example",
		busy: false,
		error: "Try again",
	});
	const job = deferred();
	let calls = 0;
	const settings = createSettings(
		{
			...state,
			create: () => {
				calls++;
				return job.promise;
			},
		},
		{},
	);
	settings.edit("password", "password123");
	settings.edit("otc", "invitation");
	const creating = settings.create();
	await settings.create();
	assert.equal(calls, 1);
	job.resolve(false);
	await creating;
	assert.equal(get(settings).password, "password123");
	assert.equal(get(settings).feedback.text, "Try again");
	const success = settings.create();
	await success;
	settings.dispose();
});

test("successful setup clears secrets, external server changes update the form, and disposal ignores late feedback", async () => {
	const state = writable({ serverUrl: "https://clip.example", busy: false });
	const job = deferred();
	const settings = createSettings(
		{ ...state, create: async () => true, backup: () => job.promise },
		{},
	);
	settings.edit("password", "password123");
	settings.edit("otc", "invitation");
	await settings.create();
	assert.equal(get(settings).password, "");
	assert.equal(get(settings).otc, "");
	state.update((value) => ({ ...value, serverUrl: "https://other.example" }));
	assert.equal(get(settings).server, "https://other.example");
	const backup = settings.backup();
	const before = get(settings);
	settings.dispose();
	job.resolve(true);
	await backup;
	assert.deepEqual(get(settings), before);
});
