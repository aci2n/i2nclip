import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createTagEditor } from "../src/lib/stores/tag-editor.js";
import { deferred } from "./helpers.js";

test("a failed save preserves its draft until explicit cancellation", async () => {
	const job = deferred();
	const editor = createTagEditor(() => job.promise);
	editor.open();
	editor.edit("keep me");
	const saving = editor.add([]);
	job.resolve(false);
	assert.equal(await saving, false);
	assert.equal(get(editor).value, "keep me");
	assert.equal(get(editor).editing, true);
	assert.equal(get(editor).value, "keep me");
	editor.cancel();
	assert.equal(get(editor).value, "");
});

test("saving serializes edits and preserves a newer draft without closing the editor", async () => {
	const job = deferred();
	let calls = 0;
	const editor = createTagEditor(() => {
		calls++;
		return job.promise;
	});
	editor.open();
	editor.edit("first");
	const saving = editor.add([]);
	await editor.add([]);
	await editor.remove([]);
	editor.edit("next");
	job.resolve(true);
	await saving;
	assert.equal(calls, 1);
	assert.equal(get(editor).value, "next");
	const next = editor.add([]);
	await next;
	assert.equal(get(editor).editing, true);
	assert.equal(get(editor).value, "");
});

test("disposing an editor prevents a late save from requesting focus", async () => {
	const job = deferred();
	const editor = createTagEditor(() => job.promise);
	editor.open();
	editor.edit("first");
	const saving = editor.add([]);
	const before = get(editor);
	editor.dispose();
	job.resolve(true);
	await saving;
	assert.deepEqual(get(editor), before);
});
