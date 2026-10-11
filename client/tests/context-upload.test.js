import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { get, writable } from "svelte/store";
import { submitContextUpload as implementation } from "../src/lib/stores/context-upload.js";
import { createPendingUpload } from "../src/lib/stores/pending-upload.js";
import {
	deferred,
	installUploadLocks,
	tick,
	workflowSession,
} from "./helpers.js";

beforeEach(installUploadLocks);

const source = { srcUrl: "https://media.example/photo.png", tabId: 7 };
const credentials = { privateKey: "key", serverUrl: "https://clip.example" };

function fixture(sendUpload) {
	const state = writable(credentials);
	const entries = {};
	const opened = [];
	const notices = [];
	let disposed = 0;
	const session = {
		subscribe: state.subscribe,
		ready: Promise.resolve(),
		credentials: () => get(state),
		dispose() {
			disposed++;
		},
	};
	const platform = {
		session: {
			get: async (key) => ({ [key]: entries[key] }),
			set: async (values) => Object.assign(entries, values),
			remove: async (key) => {
				delete entries[key];
			},
		},
		openUpload: async (id, page) => opened.push({ id, page }),
		notify: async (message) => notices.push(message),
		close() {},
	};
	return {
		state,
		entries,
		opened,
		notices,
		session,
		platform,
		services: { createSession: () => session, sendUpload },
		disposed: () => disposed,
	};
}

test("failed immediate uploads retain independent sources and retry explicitly", async (t) => {
	let sends = 0;
	const setup = fixture(async ({ source: pending }) => {
		sends++;
		assert.equal(setup.entries[`upload:${pending.id}`].srcUrl, pending.srcUrl);
		throw new Error("Temporary failure");
	});
	await Promise.all([
		submitContextUpload(source, false, setup.platform, setup.services),
		submitContextUpload(
			{ ...source, srcUrl: "https://media.example/second.png" },
			false,
			setup.platform,
			setup.services,
		),
	]);
	assert.equal(sends, 2);
	assert.equal(Object.keys(setup.entries).length, 2);
	assert.equal(new Set(setup.opened.map(({ id }) => id)).size, 2);
	assert.ok(setup.opened.every(({ page }) => page === "upload"));
	const { id } = setup.opened[0];
	const pending = createPendingUpload(
		workflowSession(setup.session, setup.platform),
		setup.platform,
		id,
		{
			prepareMedia: async (stored) => ({
				...stored,
				name: "photo.png",
				blob: new Blob(["photo"]),
			}),
			sendUpload: async () => {
				sends++;
			},
		},
	);
	t.after(pending.dispose);
	await pending.ready;
	await tick();
	assert.equal(get(pending).status, "Temporary failure");
	assert.equal(
		sends,
		2,
		"opening the retry popup must not resend automatically",
	);
	await pending.send("");
	assert.equal(sends, 3);
	assert.equal(setup.entries[`upload:${id}`], undefined);
	assert.equal(Object.keys(setup.entries).length, 1);
	assert.equal(setup.disposed(), 2);
});

test("notification failure after immediate success does not retain or retry an upload", async () => {
	const setup = fixture(async () => {});
	setup.platform.notify = async () => {
		throw new Error("Notifications unavailable");
	};
	await submitContextUpload(source, false, setup.platform, setup.services);
	assert.deepEqual(setup.entries, {});
	assert.deepEqual(setup.opened, []);
	assert.equal(setup.disposed(), 1);
});

test("changing libraries cancels an immediate upload and retains it for explicit retry", async () => {
	const job = deferred();
	let signal;
	const setup = fixture(async ({ signal: current }) => {
		signal = current;
		await job.promise;
	});
	const sending = submitContextUpload(
		source,
		false,
		setup.platform,
		setup.services,
	);
	await tick();
	setup.state.set({ ...credentials, privateKey: "other" });
	assert.equal(signal.aborted, true);
	job.resolve();
	await sending;
	assert.equal(Object.keys(setup.entries).length, 1);
	assert.equal(setup.opened[0].page, "upload");
	assert.equal(
		Object.values(setup.entries)[0].error,
		"Library changed. Upload cancelled.",
	);
});

test("reset during an immediate upload does not recreate discarded work", async () => {
	const job = deferred();
	const setup = fixture(() => job.promise);
	const sending = submitContextUpload(
		source,
		false,
		setup.platform,
		setup.services,
	);
	await tick();
	for (const key of Object.keys(setup.entries)) delete setup.entries[key];
	setup.state.set({ ...credentials, privateKey: "" });
	job.reject(new Error("Aborted"));
	await sending;
	assert.deepEqual(setup.entries, {});
	assert.deepEqual(setup.opened, []);
});

test("tagged and locked context uploads persist a source before opening their popup", async () => {
	for (const [withTags, privateKey, page] of [
		[true, "key", "upload"],
		[false, "", "unlock"],
	]) {
		const setup = fixture(() => assert.fail("upload must wait for the popup"));
		setup.state.set({ ...credentials, privateKey });
		await submitContextUpload(source, withTags, setup.platform, setup.services);
		const { id, page: actualPage } = setup.opened[0];
		assert.equal(actualPage, page);
		assert.equal(setup.entries[`upload:${id}`].srcUrl, source.srcUrl);
		assert.equal(setup.disposed(), 1);
	}
});

function submitContextUpload(source, tags, platform, services) {
	const original = services.createSession;
	return implementation(source, tags, platform, {
		...services,
		createSession: (...args) => workflowSession(original(...args), platform),
	});
}
