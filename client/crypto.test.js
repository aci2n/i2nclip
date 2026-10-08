import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bytesToHex, hexToBytes, utf8 } from "./bytes.js";
import {
  authorizationHeader,
  requestMessage,
  contentAad,
  decrypt,
  encrypt,
  metaAad,
  tagToken,
} from "./crypto.js";
import { encodePost } from "./frame.js";
import { loadKey } from "./crypto.js";

const vectors = JSON.parse(readFileSync(new URL("./test-vectors.json", import.meta.url), "utf8"));

test("openssh private key matches the rust vectors", async () => {
  const key = await loadKey(vectors.openssh_private);
  assert.equal(bytesToHex(key.publicKey), vectors.public_hex);
  assert.equal(key.authorizedLine, vectors.authorized_line);
  assert.equal(await tagToken(key, vectors.tag), vectors.token);
  assert.equal(await tagToken(key, " vacation "), vectors.token);
  assert.equal(await tagToken(key, vectors.cafe_tag), vectors.cafe_token);

  const nonce = hexToBytes(vectors.nonce_hex);
  const content = await encrypt(key, contentAad(vectors.media_id), utf8(vectors.plaintext_utf8), nonce);
  assert.equal(bytesToHex(content), vectors.ciphertext_hex);
  assert.equal(
    new TextDecoder().decode(await decrypt(key, contentAad(vectors.media_id), content)),
    vectors.plaintext_utf8,
  );
  assert.equal(new TextDecoder().decode(contentAad(vectors.media_id)), vectors.aad);

  const meta = await encrypt(key, metaAad(vectors.media_id), utf8(vectors.meta_json), nonce);
  assert.equal(bytesToHex(meta), vectors.meta_ciphertext_hex);
  const frame = encodePost({
    id: vectors.media_id,
    meta,
    content,
    tags: vectors.token,
  });
  assert.equal(bytesToHex(frame), vectors.frame_hex);

  const body = utf8(vectors.sign_body_utf8);
  const request = requestMessage({
    origin: vectors.sign_origin,
    ts: vectors.sign_ts,
    nonce: vectors.sign_nonce,
    method: vectors.sign_method,
    path: vectors.sign_path,
    hash: vectors.body_hash,
  });
  assert.equal(new TextDecoder().decode(request), vectors.request_text);
  assert.equal(
    await authorizationHeader({
      key,
      origin: vectors.sign_origin,
      ts: vectors.sign_ts,
      nonce: vectors.sign_nonce,
      method: vectors.sign_method,
      path: vectors.sign_path,
      body,
    }),
    vectors.authorization,
  );
});
