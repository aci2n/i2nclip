import assert from "node:assert/strict";
import test from "node:test";

import { unwrapPrivateKey, wrapPrivateKey } from "../src/lib/vault.js";

test("passphrase wrap roundtrips and rejects the wrong passphrase", async () => {
	const secret = "library identity document";
	const wrapped = await wrapPrivateKey(secret, "correct horse", 1_000);
	assert.equal(JSON.stringify(wrapped).includes(secret), false);
	assert.equal(await unwrapPrivateKey(wrapped, "correct horse"), secret);
	await assert.rejects(
		() => unwrapPrivateKey(wrapped, "nope"),
		/Wrong password/,
	);
});
