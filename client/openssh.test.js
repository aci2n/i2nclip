import assert from "node:assert/strict";
import test from "node:test";

import { generatePrivateKey, parsePrivateKey } from "./openssh.js";

test("a generated key parses back to the same public key", async () => {
  const created = await generatePrivateKey();
  const parsed = parsePrivateKey(created.privateKey);
  assert.match(created.authorizedLine, /^ssh-ed25519 \S+ i2nclip$/);
  assert.equal(
    Buffer.from(parsed.publicKey).toString("hex"),
    Buffer.from(parsePrivateKey(created.privateKey).publicKey).toString("hex"),
  );
});
