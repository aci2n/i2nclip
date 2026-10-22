import assert from "node:assert/strict";
import test from "node:test";
import { checkServer } from "../src/lib/protocol/server.ts";
import { createLibraryIdentity } from "../src/lib/services/library-identity.ts";

test("server URLs require HTTPS except for loopback development servers", () => {
	for (const url of [
		"https://clip.example",
		"https://clip.example:8443/path",
		"http://localhost:8080",
		"http://127.0.0.1:5173",
		"http://[::1]:8080",
	]) {
		checkServer(url);
	}
	for (const url of [
		"http://clip.example",
		"http://192.168.1.10:8080",
		"http://localhost.example",
		"ftp://clip.example",
	]) {
		assert.throws(() => checkServer(url), /HTTPS server URL/, url);
	}
	for (const url of ["not a url", "https://user:pass@clip.example"]) {
		assert.throws(() => checkServer(url), /Invalid server URL/, url);
	}
});

test("library credentials cannot name a remote plain-HTTP origin", async () => {
	await assert.rejects(
		createLibraryIdentity("http://clip.example", new AbortController().signal),
		/HTTPS server URL/,
	);
});
