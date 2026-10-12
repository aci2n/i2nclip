import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";

const source = await readFile(
	new URL("../src/lib/components/Pairing.svelte", import.meta.url),
	"utf8",
);
const compiled = compile(source, {
	generate: "server",
	filename: "Pairing.svelte",
});
const code = compiled.js.code.replace(
	/['"]svelte\/internal\/server['"]/g,
	JSON.stringify(import.meta.resolve("svelte/internal/server")),
);
const { default: Pairing } = await import(
	`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

test("Pairing renders ordinary sender/receiver/approval/error values without a store", () => {
	const props = {
		state: { active: false, status: "" },
		server: "https://clip.example",
		onSend() {},
		onReceive() {},
		onApprove() {},
		onRejectVerification() {},
		onCancel() {},
	};
	assert.match(
		render(Pairing, { props: { ...props, configured: true } }).body,
		/Create pairing code/,
	);
	assert.match(
		render(Pairing, { props: { ...props, embedded: true, busy: true } }).body,
		/<input[^>]*disabled/,
	);
	const active = render(Pairing, {
		props: {
			...props,
			state: {
				active: true,
				verificationCode: "ABCD-EFGH",
				approval: true,
				server: props.server,
				remaining: 30,
				status: "Review the code",
				error: false,
			},
		},
	}).body;
	assert.match(active, /Codes match/);
	assert.doesNotMatch(active, /\sid=/);
	assert.match(active, /<label[^>]*>[\s\S]*Verification code[\s\S]*<output/);
	assert.match(active, /Expires in 30 seconds/);
	assert.match(
		render(Pairing, {
			props: {
				...props,
				state: { active: false, status: "Failed receive", error: true },
			},
		}).body,
		/role="alert"/,
	);
});
