// Same length-prefixed body as src/frame.rs. Lengths are big-endian uint32s.

import { chunk, concat, utf8 } from "./bytes.js";

export function encodePost({ id, meta, content, tags }) {
  return concat([
    chunk(utf8(id)),
    chunk(meta),
    chunk(content),
    chunk(utf8(tags)),
  ]);
}

export function encodeMeta({ meta, tags }) {
  return concat([chunk(meta), chunk(utf8(tags))]);
}
