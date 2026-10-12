import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMessage } from "../src/lib/service/trace.js";

test("browser traces correlate requests without exposing URLs, pairing capabilities or failure text", async (t) => {
	const previous = globalThis.self;
	globalThis.self = {};
	const trace = await import("../src/lib/service/trace.js?browser-test");
	if (previous === undefined) {
		delete globalThis.self;
	} else {
		globalThis.self = previous;
	}
	const logs = [];
	t.mock.method(console, "debug", (...args) => logs.push(args));
	const response = new Response(null, { status: 204 });
	assert.equal(
		await trace.traceRequest(
			"POST",
			"/api/pairings/secret-room/messages?code=secret-code",
			async () => response,
		),
		response,
	);
	const failure = Object.assign(new Error("secret-server-reply"), {
		name: "TimeoutError",
	});
	await assert.rejects(
		trace.traceRequest(
			"GET",
			"/api/media/secret-id?tag=secret-tag",
			async () => {
				throw failure;
			},
		),
		(error) => error === failure,
	);
	trace.traceMessage("client → owner", "client-1", {
		type: "command",
		name: "pairing.receive",
		payload: {
			code: "secret-code",
			password: "secret-password",
			capability: "secret-capability",
			verificationCode: "secret-verification",
			metadata: { name: "secret-name", tags: ["secret-tag"] },
			srcUrl: "https://secret-host/image",
			thumb: "secret-thumbnail",
			error: "secret-server-reply",
		},
	});
	const output = JSON.stringify(logs);
	assert(!output.includes("secret-"));
	assert(output.includes("/api/pairings/:id/messages"));
	assert(output.includes("/api/media/:id"));
	assert(output.includes("TimeoutError"));
	assert(output.includes("pairing.receive"));
	assert.equal(logs[0][1].requestId, logs[1][1].requestId);
	assert.equal(logs[1][1].httpStatus, 204);
	assert.equal(logs[2][1].requestId, logs[3][1].requestId);
	t.mock.method(console, "debug", () => {
		throw new Error("console unavailable");
	});
	assert.equal(
		await trace.traceRequest("GET", "/api/media", async () => response),
		response,
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
