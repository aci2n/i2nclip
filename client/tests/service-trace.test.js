import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMessage } from "../src/lib/service/trace.js";
import { serviceTracingPlugin } from "../service-tracing.config.js";

test("release builds replace owner tracing with a disabled module", () => {
	const release = serviceTracingPlugin(false);
	const id = release.resolveId("./trace.js", "/src/lib/service/engine.js");
	assert(id);
	assert.match(release.load(id), /serviceTracing = false/);
	assert(!release.load(id).includes("console"));
	assert.equal(
		serviceTracingPlugin(true).resolveId(
			"./trace.js",
			"/src/lib/service/engine.js",
		),
		undefined,
	);
});

test("service traces redact secrets recursively without modifying messages", () => {
	const message = {
		type: "command",
		name: "pairing.receive",
		requestId: "request-1",
		payload: { password: "secret-password", code: "secret-code", epoch: 3 },
		value: {
			pendingRegistration: {
				wrappedKey: { ciphertext: "secret-key" },
				otc: "invite",
			},
		},
	};
	const traced = summarizeMessage(message);
	assert.equal(traced.payload.password, "[redacted]");
	assert.equal(traced.payload.code, "[redacted]");
	assert.equal(traced.value.pendingRegistration.wrappedKey, "[redacted]");
	assert.equal(traced.value.pendingRegistration.otc, "[redacted]");
	assert.equal(traced.requestId, "request-1");
	assert.equal(traced.payload.epoch, 3);
	assert.equal(message.payload.password, "secret-password");
});

test("service traces summarize binary payloads and bound array/object depth", () => {
	const traced = summarizeMessage({
		blob: new Blob(["data"], { type: "text/plain" }),
		thumb: new Uint8Array(500),
		buffer: new ArrayBuffer(100),
		jobs: Array.from({ length: 100 }, (_, id) => ({ id })),
	});
	assert.deepEqual(traced.blob, {
		binary: "Blob",
		size: 4,
		type: "text/plain",
	});
	assert.deepEqual(traced.thumb, { binary: "Uint8Array", byteLength: 500 });
	assert.deepEqual(traced.buffer, { binary: "ArrayBuffer", byteLength: 100 });
	assert.equal(traced.jobs.length, 21);
	assert.equal(traced.jobs[20], "[80 more items]");
	const cyclic = {};
	cyclic.self = cyclic;
	assert.match(JSON.stringify(summarizeMessage(cyclic)), /nested object/);
});
