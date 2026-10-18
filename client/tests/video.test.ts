import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as bunny from "mediabunny";
import { defaultUploadOptions } from "../src/lib/media/options.ts";
import { convertVideo } from "../src/lib/media/video.ts";
import { deferred } from "./helpers.ts";

const options = () => ({ ...defaultUploadOptions().video, enabled: true });
const file = () =>
	new File([new Uint8Array(1000)], "Holiday.MOV", { type: "video/quicktime" });

// A browser boundary double: no global codec mocks or shared mutable resources.
function runtime({
	size = 100,
	width = 1920,
	height = 1080,
	fps = 60,
	valid = true,
	discarded = false,
	hasVideo = true,
	finalized = true,
	initialize,
	execute,
}: {
	size?: number;
	width?: number;
	height?: number;
	fps?: number;
	valid?: boolean;
	discarded?: boolean;
	hasVideo?: boolean;
	finalized?: boolean;
	initialize?: () => Promise<void>;
	execute?: () => Promise<void>;
} = {}) {
	let disposed = 0;
	let canceled = 0;
	let executed = 0;
	let listening = false;
	let initialization: bunny.ConversionOptions | undefined;
	let config: bunny.ConversionVideoOptions | undefined;
	let writes: ((value: { end: number }) => void) | undefined;
	let target: Target;
	let output: Output;
	let lateProgress: ((percent: number, time: number) => unknown) | undefined;
	class Target {
		buffer: ArrayBuffer | null = null;
		on(_name: string, callback: typeof writes) {
			writes = callback;
			listening = true;
			return () => {
				listening = false;
			};
		}
	}
	class Output {
		state = "pending";
		constructor(args: { target: Target }) {
			target = args.target;
			output = this;
		}
		async cancel() {
			canceled++;
			this.state = "canceled";
		}
	}
	const track = {
		getDisplayWidth: async () => width,
		getDisplayHeight: async () => height,
		computePacketStats: async () => ({ averagePacketRate: fps }),
	};
	const conversion = {
		state: "idle",
		isValid: valid,
		discardedTracks: discarded ? [{}] : [],
		onProgress: undefined as typeof lateProgress,
		async cancel() {
			this.state = "canceled";
			await output.cancel();
		},
		async execute() {
			executed++;
			this.state = "executing";
			lateProgress = this.onProgress;
			this.onProgress?.(0.5, 1);
			await execute?.();
			writes?.({ end: size });
			if (this.state === "canceled") {
				throw new Error("canceled");
			}
			target.buffer = new ArrayBuffer(size);
			output.state = finalized ? "finalized" : "started";
			this.state = "done";
		},
	};
	const module = {
		...bunny,
		BufferTarget: Target,
		Output,
		Input: class {
			async getVideoTracks() {
				return hasVideo ? [track] : [];
			}
			dispose() {
				disposed++;
			}
		},
		Conversion: {
			async init(args: bunny.ConversionOptions) {
				initialization = args;
				if (typeof args.video === "function") {
					config = (await args.video(
						track as unknown as bunny.InputVideoTrack,
						0,
					)) as bunny.ConversionVideoOptions;
				}
				await initialize?.();
				return conversion;
			},
		},
	} as unknown as typeof bunny;
	return {
		module,
		get config() {
			return config;
		},
		get initialization() {
			return initialization;
		},
		get disposed() {
			return disposed;
		},
		get canceled() {
			return canceled;
		},
		get executed() {
			return executed;
		},
		get listening() {
			return listening;
		},
		get conversion() {
			return conversion;
		},
		lateProgress: () => lateProgress?.(0.9, 2),
	};
}

for (const format of ["mp4", "webm"] as const) {
	test(`${format} conversion uses finalized smaller output and retains all tracks`, async () => {
		const r = runtime();
		const notices: string[] = [];
		const progress: number[] = [];
		const result = await convertVideo(
			file(),
			new AbortController().signal,
			{
				...options(),
				format,
				codec: format === "mp4" ? "avc" : "vp9",
				quality: "low",
			},
			(text) => notices.push(text),
			(n) => progress.push(n),
			r.module,
		);
		assert.equal(result.name, `Holiday.${format}`);
		assert.equal(result.type, `video/${format}`);
		assert.equal(result.size, 100);
		assert.equal(r.initialization?.tracks, "all");
		assert.equal(r.initialization?.audio, undefined); // Let native copy/transcode preserve audio.
		assert.equal(r.config?.forceTranscode, true);
		assert.equal(r.config?.codec, format === "mp4" ? "avc" : "vp9");
		assert.deepEqual(r.config?.quality, new bunny.Quality("low"));
		assert.deepEqual(notices, []);
		assert.deepEqual(progress, [0, 50, 100]);
		r.lateProgress();
		assert.deepEqual(progress, [0, 50, 100]);
		assert(r.disposed > 0);
		assert.equal(r.listening, false);
	});
}

for (const [description, setup] of [
	["no video", { hasVideo: false }],
	["discarded audio", { discarded: true }],
	["unsupported codec", { valid: false }],
	["empty output", { size: 0 }],
	["incomplete output", { finalized: false }],
	["equal output", { size: 1000 }],
	["larger output", { size: 2000 }],
	[
		"encoder failure",
		{
			execute: async () => {
				throw new Error("encoder");
			},
		},
	],
] as const) {
	test(`uses original with notice for ${description} and cleans up`, async () => {
		const r = runtime(setup);
		const original = file();
		const notices: string[] = [];
		assert.equal(
			await convertVideo(
				original,
				new AbortController().signal,
				options(),
				(message) => notices.push(message),
				undefined,
				r.module,
			),
			original,
		);
		assert.equal(notices.length, 1);
		assert.match(notices[0], /^Using original:/);
		assert(r.disposed > 0);
		assert.equal(r.canceled > 0, !("size" in setup && setup.size === 0));
		assert.equal(r.listening, false);
		if ("hasVideo" in setup || "discarded" in setup || "valid" in setup) {
			assert.equal(r.executed, 0);
		}
	});
}

for (const [width, height, maxWidth, maxHeight, expected] of [
	[1920, 1080, 800, 800, [800, 450]],
	[1080, 1920, 800, 800, [450, 800]],
	[641, 481, null, null, [640, 480]],
	[320, 180, 800, null, [320, 180]],
	[1920, 1080, null, 300, [532, 300]],
] as const) {
	test(`fits displayed ${width}x${height} without upscaling`, async () => {
		const r = runtime({ width, height });
		await convertVideo(
			file(),
			new AbortController().signal,
			{ ...options(), maxWidth, maxHeight },
			undefined,
			undefined,
			r.module,
		);
		assert.deepEqual([r.config?.width, r.config?.height], expected);
		assert.equal(r.config?.fit, "contain");
		assert.equal(r.config?.allowTransformationMetadata, false);
	});
}

for (const cap of [24, 60, 120, null]) {
	test(`frame rate cap ${cap} does not increase source rate`, async () => {
		const r = runtime();
		await convertVideo(
			file(),
			new AbortController().signal,
			{ ...options(), maxFrameRate: cap },
			undefined,
			undefined,
			r.module,
		);
		assert.equal(r.config?.frameRate, cap === 24 ? 24 : undefined);
	});
}

test("disabled video conversion does not initialize resources", async () => {
	const original = file();
	const r = runtime();
	assert.equal(
		await convertVideo(
			original,
			new AbortController().signal,
			defaultUploadOptions().video,
			undefined,
			undefined,
			r.module,
		),
		original,
	);
	assert.equal(r.initialization, undefined);
	assert.equal(r.disposed, 0);
});

for (const phase of ["initializing", "executing"]) {
	test(`abort during ${phase} rejects without fallback or stale progress`, async () => {
		const waiting = deferred();
		const entered = deferred();
		const hold = async () => {
			entered.resolve();
			await waiting.promise;
		};
		const r = runtime({
			initialize: phase === "initializing" ? hold : undefined,
			execute: phase === "executing" ? hold : undefined,
		});
		const controller = new AbortController();
		const notices: string[] = [];
		const progress: number[] = [];
		const pending = convertVideo(
			file(),
			controller.signal,
			options(),
			(message) => notices.push(message),
			(n) => progress.push(n),
			r.module,
		);
		await entered.promise;
		controller.abort();
		const count = progress.length;
		r.lateProgress();
		assert.equal(progress.length, count);
		waiting.resolve();
		await assert.rejects(pending, { name: "AbortError" });
		assert.deepEqual(notices, []);
		assert.equal(r.listening, false);
		assert(r.disposed > 0);
		assert(r.canceled > 0);
	});
}

test("Mediabunny parses the checked-in WebM fixture without browser codecs", async () => {
	const bytes = await readFile(
		new URL("../e2e/fixtures/clip.webm", import.meta.url),
	);
	const input = new bunny.Input({
		source: new bunny.BlobSource(new Blob([bytes])),
		formats: [bunny.WEBM],
	});
	try {
		const tracks = await input.getVideoTracks();
		assert.equal(tracks.length, 1);
		assert((await tracks[0].getDisplayWidth()) > 0);
		assert((await tracks[0].getDisplayHeight()) > 0);
	} finally {
		input.dispose();
	}
});
