import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { defaultLibraryName } from "../src/lib/stores/library-name.js";
import { createSettings } from "../src/lib/stores/settings.js";

test("library suggestions use the lowest unused Personal number", () => {
	for (const [names, expected] of [
		[[], "Personal 1"],
		[["Personal"], "Personal 2"],
		[["Personal 1", "Personal 2"], "Personal 3"],
		[["Personal 1", "Personal 3"], "Personal 2"],
		[["personal", "PERSONAL 2", "Personal 04"], "Personal 3"],
		[
			["Work", "Personal 0", "Personal x", "Personal 9007199254740992"],
			"Personal 1",
		],
	]) {
		assert.equal(defaultLibraryName(names.map((name) => ({ name }))), expected);
	}
});

test("first setup uses an editable suggestion and switching preserves saved library names", async () => {
	const state = writable({
		libraryId: "first",
		libraryName: "Personal",
		configured: false,
		serverUrl: "https://clip.example",
		catalog: [],
	});
	let submitted;
	const settings = createSettings(
		{
			...state,
			create: async (payload) => {
				submitted = payload;
				return true;
			},
		},
		{},
	);
	assert.equal(get(settings).libraryName, "Personal 1");
	settings.edit("libraryName", "Custom");
	await settings.create();
	assert.equal(submitted.libraryName, "Custom");
	state.set({
		libraryId: "saved",
		libraryName: "Archive",
		configured: true,
		catalog: [{ name: "Archive" }],
		serverUrl: "https://clip.example",
	});
	assert.equal(get(settings).libraryName, "Archive");
	settings.dispose();
});
