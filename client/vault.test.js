import assert from "node:assert/strict";
import test from "node:test";

import { unwrapPrivateKey, wrapPrivateKey } from "./vault.js";

test("passphrase wrap roundtrips and rejects the wrong passphrase", async () => {
  const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n";
  const wrapped = await wrapPrivateKey(secret, "correct horse", 1_000);
  assert.equal(JSON.stringify(wrapped).includes("not-a-real-key"), false);
  assert.equal(await unwrapPrivateKey(wrapped, "correct horse"), secret);
  await assert.rejects(() => unwrapPrivateKey(wrapped, "nope"), /Wrong passphrase/);
});
