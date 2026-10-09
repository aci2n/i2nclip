import assert from "node:assert/strict";
import test from "node:test";

import { sniffContentType } from "../src/lib/metadata.js";

test("sniffs jpeg and png when the browser gave no type", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(sniffContentType(jpeg, ""), "image/jpeg");
  assert.equal(sniffContentType(png, "application/octet-stream"), "image/png");
  assert.equal(sniffContentType(jpeg, "image/png"), "image/png");
});
