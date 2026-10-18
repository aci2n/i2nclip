import assert from "node:assert/strict";
import test from "node:test";
import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import {
	defaultUploadOptions,
	type UploadOptions,
} from "../src/lib/media/options.ts";
import type { SendOptions } from "../src/lib/media/upload.ts";
import { createUploads } from "../src/lib/stores/uploads.ts";
import { assertPresent } from "./assert.ts";
import { deferred, testKey, tick } from "./helpers.ts";
import { captureLogs } from "./log-capture.ts";
import { documentResponse } from "./msgpack-response.ts";

function session() {
	const controller = new AbortController();
	return {
		serverUrl: "https://clip.example",
		key: testKey(),
		signal: controller.signal,
		end: () => controller.abort(),
	};
}

function fixture(
	t: test.TestContext,
	options: {
		send?: (options: SendOptions) => Promise<{ id: string }>;
		preferences?: Readable<{ options: UploadOptions }>;
	} = {},
) {
	const owner = session();
	let refreshes = 0;
	const uploads = createUploads(owner, {
		onComplete: async () => {
			refreshes++;
		},
		...options,
	});
	t.after(uploads.dispose);
	owner.signal.addEventListener("abort", uploads.dispose, { once: true });
	return { owner, uploads, refreshes: () => refreshes };
}
test("uploads run sequentially, continue after failures, and report failures for manual resubmission", async (t) => {
	const logs = captureLogs(t);
	const active = deferred();
	const entered = deferred();
	const seen: Array<string> = [];
	let fail = true;
	let oldProgress: ((percent: number) => void) | undefined;
	const f = fixture(t, {
		send: async ({ file, onProgress }) => {
			seen.push(file.name);
			if (file.name === "first") {
				oldProgress = onProgress;
				entered.resolve();
				await active.promise;
			}
			if (file.name === "bad" && fail) {
				throw new Error("network failed");
			}
			return { id: file.name };
		},
	});

	await tick();
	const files = ["first", "bad", "last"].map((name) => new File([], name));
	const uploading = f.uploads.upload(files);
	await entered.promise;
	assert.deepEqual(seen, ["first"]);
	assert.equal(await f.uploads.upload([new File([], "overlap")]), false);
	active.resolve();
	assert.equal(await uploading, false);
	assert.equal(f.refreshes(), 1);
	assert.deepEqual(seen, ["first", "bad", "last"]);
	assert.deepEqual(get(f.uploads).failures, [
		{ name: "bad", error: "network failed" },
	]);
	assertPresent(oldProgress)(99);
	assert.equal(get(f.uploads).progress, null);
	fail = false;
	const resubmitting = f.uploads.upload([new File([], "bad")]);
	assert.deepEqual(get(f.uploads).failures, []);
	assert.equal(await resubmitting, true);
	assert.equal(f.refreshes(), 2);
	assert.deepEqual(seen, ["first", "bad", "last", "bad"]);
	assert.deepEqual(get(f.uploads).failures, []);
	const failed = logs.find(
		(entry) => entry.event === "[i2nclip] uploads.file-failed",
	);
	assert.equal(failed?.level, "warn");
	assert.equal(failed?.fields.index, 2);
	assert(
		logs.some(
			(entry) =>
				entry.event === "[i2nclip] uploads.file-completed" &&
				entry.fields.index === 3 &&
				entry.fields.operation === failed?.fields.operation,
		),
	);
	const batches = logs.filter(
		(entry) => entry.event === "[i2nclip] uploads.completed",
	);
	assert.deepEqual(
		batches.map((entry) => entry.fields.failures),
		[1, 0],
	);
	assert(!JSON.stringify(logs).includes("network failed"));
	for (const name of ["first", "bad", "last"]) {
		assert(!JSON.stringify(logs).includes(`"${name}"`));
	}
});
test("identity changes and disposal abort uploads and suppress late completion and progress", async (t) => {
	const logs = captureLogs(t);
	for (const end of ["context", "dispose"]) {
		const pending = deferred<{
			id: string;
		}>();
		let signal: AbortSignal | undefined;
		let progress: ((percent: number) => void) | undefined;
		const f = fixture(t, {
			send: (args) => {
				signal = args.signal;
				progress = args.onProgress;
				return pending.promise;
			},
		});

		const uploading = f.uploads.upload([new File([], "pending")]);
		if (end === "context") {
			f.owner.end();
		} else {
			f.uploads.dispose();
		}
		assert.equal(assertPresent(signal).aborted, true);
		assertPresent(progress)(50);
		pending.resolve({ id: "late" });
		assert.equal(await uploading, false);
		assert.deepEqual(get(f.uploads), {
			uploading: false,
			pending: [],
			notices: [],
			progress: null,
			failures: [],
			completed: [],
			status: "",
		});
		assert.equal(f.refreshes(), 0);
		assert(
			!logs.some((entry) => entry.event === "[i2nclip] uploads.file-completed"),
		);
		assert(!logs.some((entry) => entry.level === "error"));
		assert(logs.some((entry) => entry.event === "[i2nclip] uploads.cancelled"));
	}
});
test("a batch snapshots compression preferences and the next batch sees changes", async (t) => {
	const preferences = writable({ options: defaultUploadOptions() });
	const seen: Array<boolean | undefined> = [];
	const f = fixture(t, {
		preferences,
		send: async ({ options }) => {
			seen.push(options?.image.enabled);
			preferences.set({
				options: {
					...defaultUploadOptions(),
					image: { ...defaultUploadOptions().image, enabled: false },
				},
			});
			return { id: String(seen.length) };
		},
	});

	await f.uploads.upload([new File([], "first"), new File([], "second")]);
	await f.uploads.upload([new File([], "third")]);
	assert.deepEqual(seen, [true, true, false]);
});

test("a configured file limit rejects an oversized file without stopping the batch and supports retry after raising it", async (t) => {
	let limit = 2;
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => {
		requests++;
		return documentResponse(
			{ id: `saved-${requests}`, created_at: 1 },
			{ status: 201 },
		);
	});
	const uploads = createUploads(session(), {
		getMaxFilePlaintextBytes: () => limit,
		onComplete: () => {},
	});
	t.after(uploads.dispose);
	const large = new File([new Uint8Array(3)], "large.bin");
	const small = new File([new Uint8Array(2)], "small.bin");
	assert.equal(await uploads.upload([large, small]), false);
	assert.equal(requests, 1);
	assert.deepEqual(get(uploads).failures, [
		{ name: "large.bin", error: "File is larger than 2 bytes." },
	]);
	assert.equal(get(uploads).completed[0].name, "small.bin");
	limit = 3;
	assert.equal(await uploads.upload([large]), true);
	assert.equal(requests, 2);
	assert.deepEqual(get(uploads).failures, []);
});

test("review entries copy defaults independently, append duplicates and reset explicitly", async (t) => {
	const preferences = writable({ options: defaultUploadOptions() });
	const seen: SendOptions[] = [];
	const f = fixture(t, {
		preferences,
		send: async (args) => {
			seen.push(args);
			return { id: String(seen.length) };
		},
	});
	const file = new File([], "same.png", { type: "image/png" });
	f.uploads.stage([file, file]);
	const [a, b] = get(f.uploads).pending;
	assert.notEqual(a.key, b.key);
	assert.notEqual(a.options.image, b.options.image);
	const changed = {
		...defaultUploadOptions(),
		image: { ...a.options.image, quality: 30 },
	};
	f.uploads.editOptions(a.key, changed);
	changed.image.quality = 12;
	assert.equal(get(f.uploads).pending[0].options.image.quality, 30);
	assert.equal(get(f.uploads).pending[1].options.image.quality, 85);
	preferences.set({
		options: {
			...defaultUploadOptions(),
			image: { ...defaultUploadOptions().image, quality: 60 },
		},
	});
	f.uploads.stage([file]);
	assert.deepEqual(
		get(f.uploads).pending.map((e) => e.options.image.quality),
		[30, 85, 60],
	);
	f.uploads.useDefaults(b.key);
	assert.deepEqual(
		get(f.uploads).pending.map((e) => e.options.image.quality),
		[30, 60, 60],
	);
	assert.equal(await f.uploads.upload([file]), false);
	assert.equal(seen.length, 0);
	f.uploads.remove(get(f.uploads).pending[2].key);
	assert.equal(await f.uploads.start(), true);
	assert.deepEqual(
		seen.map((e) => e.options?.image.quality),
		[30, 60],
	);
	assert.equal(get(f.uploads).pending.length, 0);
	f.uploads.stage([file]);
	f.uploads.cancel();
	assert.equal(get(f.uploads).pending.length, 0);
	assert.equal(await f.uploads.start(), false);
});

test("starting review freezes options and rejects staging; notices ignore late callbacks", async (t) => {
	const wait = deferred<{ id: string }>();
	let args: SendOptions | undefined;
	const f = fixture(t, {
		send: (options) => {
			args = options;
			return wait.promise;
		},
	});
	const file = new File([], "photo.png", { type: "image/png" });
	f.uploads.stage([file]);
	const entry = get(f.uploads).pending[0];
	const uploading = f.uploads.start();
	entry.options.image.quality = 0;
	assert.equal(args?.options?.image.quality, 85);
	f.uploads.stage([file]);
	assert.equal(get(f.uploads).pending.length, 0);
	assert.equal(await f.uploads.start(), false);
	assertPresent(args).onNotice?.("Original uploaded: unsupported.");
	assert.equal(get(f.uploads).notices.length, 1);
	wait.resolve({ id: "saved" });
	await uploading;
	assertPresent(args).onNotice?.("late");
	assert.equal(get(f.uploads).notices.length, 1);
	f.uploads.dismissCompleted();
	assert.deepEqual(get(f.uploads).notices, []);
});

test("pending files survive subscriber changes but are discarded with their owner", (t) => {
	const f = fixture(t);
	f.uploads.stage([new File([], "pending")]);
	const stop = f.uploads.subscribe(() => {});
	stop();
	assert.equal(get(f.uploads).pending.length, 1);
	f.owner.end();
	assert.equal(get(f.uploads).pending.length, 0);
	f.uploads.stage([new File([], "late")]);
	assert.equal(get(f.uploads).pending.length, 0);
});

test("video review snapshots stay independent and phase callbacks cannot go stale", async (t) => {
	const wait = deferred<{ id: string }>();
	let callbacks: SendOptions | undefined;
	const preferences = writable({ options: defaultUploadOptions() });
	const f = fixture(t, {
		preferences,
		send: (args) => {
			callbacks = args;
			return wait.promise;
		},
	});
	f.uploads.stage([new File([], "one.mp4"), new File([], "two.mp4")]);
	const [a, b] = get(f.uploads).pending;
	assert.notEqual(a.options.video, b.options.video);
	f.uploads.editOptions(a.key, {
		...a.options,
		video: { ...a.options.video, enabled: true, maxWidth: 640 },
	});
	assert.equal(get(f.uploads).pending[1].options.video.enabled, false);
	preferences.set({
		options: {
			...defaultUploadOptions(),
			video: { ...defaultUploadOptions().video, enabled: true, maxWidth: 800 },
		},
	});
	assert.equal(get(f.uploads).pending[0].options.video.maxWidth, 640);
	f.uploads.useDefaults(a.key);
	assert.equal(get(f.uploads).pending[0].options.video.maxWidth, 800);
	f.uploads.remove(b.key);
	const uploading = f.uploads.start();
	assert.equal(get(f.uploads).progress?.phase, "preparing");
	assertPresent(callbacks).onConversionProgress?.(25);
	assert.equal(get(f.uploads).progress?.phase, "converting");
	assert.equal(get(f.uploads).progress?.percent, 25);
	assertPresent(callbacks).onProgress?.(10);
	assertPresent(callbacks).onConversionProgress?.(99);
	assert.equal(get(f.uploads).progress?.phase, "uploading");
	assert.equal(get(f.uploads).progress?.percent, 10);
	wait.resolve({ id: "saved" });
	await uploading;
	assertPresent(callbacks).onConversionProgress?.(50);
	assert.equal(get(f.uploads).progress, null);
});

test("upload progress and completion use prepared filenames and ignore late changes", async (t) => {
	const wait = deferred<{ id: string }>();
	let args: SendOptions | undefined;
	const f = fixture(t, {
		send: (options) => {
			args = options;
			return wait.promise;
		},
	});
	const uploading = f.uploads.upload([new File([], "source.png")]);
	assertPresent(args).onPrepared?.("source.webp");
	assertPresent(args).onProgress?.(25);
	assert.equal(get(f.uploads).progress?.name, "source.webp");
	wait.resolve({ id: "saved" });
	await uploading;
	assert.deepEqual(get(f.uploads).completed, [
		{ id: "saved", name: "source.webp" },
	]);
	assertPresent(args).onPrepared?.("stale.png");
	assert.equal(get(f.uploads).progress, null);
	assert.equal(get(f.uploads).completed[0].name, "source.webp");
});
