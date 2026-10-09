import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey, parsePrivateKey } from "../src/lib/identity.js";
import { loadKey } from "../src/lib/crypto.js";

test("generated identities load and mismatched public keys are rejected", async () => {
  const first = await generatePrivateKey();
  const second = await generatePrivateKey();
  const key = await loadKey(first.privateKey);
  assert.equal(key.registrationKey, first.publicKey);
  assert.equal(key.privateCryptoKey.extractable, false);
  assert.equal(parsePrivateKey(first.privateKey).seed.length, 32);
  const mismatched = { ...JSON.parse(first.privateKey), publicKey: second.publicKey };
  await assert.rejects(loadKey(JSON.stringify(mismatched)), /does not match/);
  for (const text of ["invalid", "null", '{"v":2}', '{"v":1,"seed":"AAAA","publicKey":"AAAA"}']) {
    assert.throws(() => parsePrivateKey(text), /Invalid library identity/);
  }
});
